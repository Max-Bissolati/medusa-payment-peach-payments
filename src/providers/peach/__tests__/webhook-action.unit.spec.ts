import { PeachOptions } from "../types"

// ── Mock verification (always valid) + the Peach status client. The webhook handler's
//    job under test is the decision logic AFTER verification: the body-action gate and the
//    authoritative /status re-confirmation. ──
const mockVerify = jest.fn((..._args: any[]) => ({ valid: true, scheme: "classic" }))
jest.mock("../lib/verify-webhook", () => ({
  verifyPeachWebhook: (...args: any[]) => mockVerify(...args),
}))

const mockGetStatus = jest.fn()
jest.mock("../lib/peach-client", () => ({
  PeachClient: jest.fn().mockImplementation(() => ({ getStatus: mockGetStatus })),
}))

import PeachProviderService from "../service"

const logger = { info: () => {}, warn: () => {}, error: () => {} } as any

const OPTS: PeachOptions = {
  mode: "sandbox",
  clientId: "cid",
  clientSecret: "csecret",
  merchantId: "mid",
  entityId: "ent_123",
  secretToken: "sek",
  notificationUrl: "https://api.example.com/hooks/payment/peach_checkout",
}

function makeService() {
  return new PeachProviderService({ logger } as any, OPTS)
}

// Build a webhook payload the way Medusa hands it to getWebhookActionAndData.
function payload(fields: Record<string, string>) {
  const rawBody = new URLSearchParams(fields).toString()
  return { headers: {}, rawData: Buffer.from(rawBody, "utf8"), data: {} } as any
}

beforeEach(() => {
  mockVerify.mockClear()
  mockVerify.mockReturnValue({ valid: true, scheme: "classic" })
  mockGetStatus.mockReset()
})

describe("getWebhookActionAndData: verification gate", () => {
  it("returns not_supported when verification fails (never calls /status)", async () => {
    mockVerify.mockReturnValue({ valid: false, reason: "signature_mismatch" } as any)
    const svc = makeService()
    const res = await svc.getWebhookActionAndData(
      payload({
        "result.code": "000.100.110",
        checkoutId: "co_1",
        "customParameters[medusaSessionId]": "payses_1",
      })
    )
    expect(res.action).toBe("not_supported")
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it("returns not_supported when the session id is missing", async () => {
    const svc = makeService()
    const res = await svc.getWebhookActionAndData(
      payload({ "result.code": "000.100.110", checkoutId: "co_1" })
    )
    expect(res.action).toBe("not_supported")
    expect(mockGetStatus).not.toHaveBeenCalled()
  })
})

describe("getWebhookActionAndData: idempotency / replay", () => {
  it("duplicate success webhook -> deterministic {action:'captured'} both times", async () => {
    mockGetStatus.mockResolvedValue({
      resultCode: "000.100.110",
      medusaSessionId: "payses_1",
      amount: "1400.00",
      raw: { amount: "1400.00" },
    })
    const svc = makeService()
    const p = payload({
      "result.code": "000.100.110",
      checkoutId: "co_1",
      amount: "1400.00",
      "customParameters[medusaSessionId]": "payses_1",
    })

    const first = await svc.getWebhookActionAndData(p)
    const second = await svc.getWebhookActionAndData(
      payload({
        "result.code": "000.100.110",
        checkoutId: "co_1",
        amount: "1400.00",
        "customParameters[medusaSessionId]": "payses_1",
      })
    )

    expect(first.action).toBe("captured")
    expect(second.action).toBe("captured")
    expect(first.data?.session_id).toBe("payses_1")
    expect(second.data?.session_id).toBe("payses_1")
    // Both carry the authoritative amount from /status.
    expect(Number((first.data as any).amount?.valueOf?.() ?? (first.data as any).amount)).toBe(1400)
  })

  it("out-of-order cancel webhook after capture -> not_supported (never downgrades)", async () => {
    // 100.396.101 = cancelled-by-user. The body-action gate stops it before any /status call.
    const svc = makeService()
    const res = await svc.getWebhookActionAndData(
      payload({
        "result.code": "100.396.101",
        checkoutId: "co_1",
        "customParameters[medusaSessionId]": "payses_1",
      })
    )
    expect(res.action).toBe("not_supported")
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it("a pending (000.200.*) webhook -> not_supported (only success drives completion)", async () => {
    const svc = makeService()
    const res = await svc.getWebhookActionAndData(
      payload({
        "result.code": "000.200.000",
        checkoutId: "co_1",
        "customParameters[medusaSessionId]": "payses_1",
      })
    )
    expect(res.action).toBe("not_supported")
    expect(mockGetStatus).not.toHaveBeenCalled()
  })
})

describe("getWebhookActionAndData: /status confirmation (defence-in-depth)", () => {
  it("body claims success but /status says non-success -> not_supported", async () => {
    mockGetStatus.mockResolvedValue({
      resultCode: "800.100.153", // declined per the authoritative /status
      medusaSessionId: "payses_1",
      raw: { amount: "1400.00" },
    })
    const svc = makeService()
    const res = await svc.getWebhookActionAndData(
      payload({
        "result.code": "000.100.110", // body LIES
        checkoutId: "co_1",
        amount: "9999.00",
        "customParameters[medusaSessionId]": "payses_1",
      })
    )
    expect(res.action).toBe("not_supported")
    expect(mockGetStatus).toHaveBeenCalledWith("co_1")
  })

  it("success webhook without checkoutId -> not_supported (cannot confirm)", async () => {
    const svc = makeService()
    const res = await svc.getWebhookActionAndData(
      payload({ "result.code": "000.100.110", "customParameters[medusaSessionId]": "payses_1" })
    )
    expect(res.action).toBe("not_supported")
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it("when /status throws, returns not_supported (fails closed)", async () => {
    mockGetStatus.mockRejectedValue(new Error("status unreachable"))
    const svc = makeService()
    const res = await svc.getWebhookActionAndData(
      payload({
        "result.code": "000.100.110",
        checkoutId: "co_1",
        "customParameters[medusaSessionId]": "payses_1",
      })
    )
    expect(res.action).toBe("not_supported")
  })

  it("session_id and amount come from /status, NOT the (replayable) body", async () => {
    mockGetStatus.mockResolvedValue({
      resultCode: "000.100.110",
      medusaSessionId: "payses_AUTHORITATIVE",
      amount: "1400.00",
      raw: { amount: "1400.00" },
    })
    const svc = makeService()
    const res = await svc.getWebhookActionAndData(
      payload({
        "result.code": "000.100.110",
        checkoutId: "co_1",
        amount: "9999.00", // body amount differs
        "customParameters[medusaSessionId]": "payses_BODY", // body session differs
      })
    )
    expect(res.action).toBe("captured")
    expect(res.data?.session_id).toBe("payses_AUTHORITATIVE")
    expect(Number((res.data as any).amount?.valueOf?.() ?? (res.data as any).amount)).toBe(1400)
  })

  it("success webhook where /status yields NO amount -> not_supported (no body fallback)", async () => {
    // /status re-confirms the outcome but returns no authoritative amount. We must NOT fall back
    // to the (replayable) body amount: fail closed.
    mockGetStatus.mockResolvedValue({
      resultCode: "000.100.110",
      medusaSessionId: "payses_1",
      raw: {}, // no amount anywhere
    })
    const svc = makeService()
    const res = await svc.getWebhookActionAndData(
      payload({
        "result.code": "000.100.110",
        checkoutId: "co_1",
        amount: "1400.00", // body HAS an amount: must be ignored
        "customParameters[medusaSessionId]": "payses_1",
      })
    )
    expect(res.action).toBe("not_supported")
    expect(mockGetStatus).toHaveBeenCalledWith("co_1")
  })
})
