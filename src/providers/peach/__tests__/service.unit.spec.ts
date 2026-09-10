import { MedusaError } from "@medusajs/framework/utils"
import { PeachOptions } from "../types"

// ── Mock the Peach HTTP client so the provider's flow logic is tested in isolation. ──
const mockCreateCheckout = jest.fn()
const mockGetStatus = jest.fn()
const mockRefund = jest.fn()

jest.mock("../lib/peach-client", () => {
  return {
    PeachClient: jest.fn().mockImplementation(() => ({
      createCheckout: mockCreateCheckout,
      getStatus: mockGetStatus,
      refund: mockRefund,
      sdkUrl: "https://sandbox-checkout.peachpayments.com/js/checkout.js",
      mode: "sandbox",
    })),
  }
})

import PeachProviderService from "../service"

const logger = { info: () => {}, warn: () => {}, error: () => {} } as any

const OPTS: PeachOptions = {
  mode: "sandbox",
  clientId: "cid",
  clientSecret: "csecret",
  merchantId: "mid",
  entityId: "ent_123",
  referer: "https://store.example.com",
}

function makeService(opts: Partial<PeachOptions> = {}) {
  return new PeachProviderService({ logger } as any, { ...OPTS, ...opts })
}

beforeEach(() => {
  mockCreateCheckout.mockReset()
  mockGetStatus.mockReset()
  mockRefund.mockReset()
})

describe("PeachProviderService identifier", () => {
  it("is registered under the identifier 'peach'", () => {
    expect((PeachProviderService as any).identifier).toBe("peach")
  })
})

describe("PeachProviderService.validateOptions", () => {
  it("stays permissive about credentials (no throw on empty options)", () => {
    expect(() => (PeachProviderService as any).validateOptions({})).not.toThrow()
    expect(() => (PeachProviderService as any).validateOptions({ clientId: undefined })).not.toThrow()
  })

  it("throws at boot on a malformed resultCodeOverrides value, naming the key and value", () => {
    expect(() =>
      (PeachProviderService as any).validateOptions({
        resultCodeOverrides: { "000.100.110": "banana" },
      })
    ).toThrow(/resultCodeOverrides\["000\.100\.110"\].*"banana"/)
  })

  it("throws when resultCodeOverrides is not an object", () => {
    expect(() =>
      (PeachProviderService as any).validateOptions({ resultCodeOverrides: "captured" })
    ).toThrow(/resultCodeOverrides must be an object/)
  })

  it("accepts a valid overrides map (every legal PaymentSessionStatus value)", () => {
    expect(() =>
      (PeachProviderService as any).validateOptions({
        resultCodeOverrides: {
          "000.400.101": "authorized",
          "000.400.102": "captured",
          "100.396.104": "canceled",
          "000.200.000": "pending",
          "300.100.100": "requires_more",
          "800.100.150": "error",
        },
      })
    ).not.toThrow()
  })
})

describe("PeachProviderService.initiatePayment", () => {
  it("returns checkoutId as id, pending status, and full data (preserving session_id)", async () => {
    mockCreateCheckout.mockResolvedValue({
      checkoutId: "co_abc",
      redirectUrl: "https://secure/redir",
      raw: {},
    })
    const svc = makeService()
    const out = await svc.initiatePayment({
      amount: 15000 as any,
      currency_code: "zar",
      data: { session_id: "payses_xyz" },
    } as any)

    expect(out.id).toBe("co_abc")
    expect(out.status).toBe("pending")
    expect(out.data).toMatchObject({
      checkoutId: "co_abc",
      redirectUrl: "https://secure/redir",
      entityId: "ent_123",
      amount: "15000.00",
      currency: "ZAR",
      sdkUrl: "https://sandbox-checkout.peachpayments.com/js/checkout.js",
      mode: "sandbox",
      session_id: "payses_xyz", // Medusa-injected field preserved
    })
    // merchantTransactionId is minted (8-16 chars) and passed to the client.
    const callArgs = mockCreateCheckout.mock.calls[0][0]
    expect(callArgs.merchantTransactionId).toMatch(/^[0-9a-f]{12}$/)
    expect(callArgs.amount).toBe("15000.00")
    expect(callArgs.currency).toBe("ZAR")
    expect(callArgs.sessionId).toBe("payses_xyz")
    // Card flow unchanged: no requiresShipping unless the storefront asks for it.
    expect(callArgs.requiresShipping).toBeUndefined()
  })

  it("passes data.requiresShipping through to createCheckout (Embedded Express)", async () => {
    mockCreateCheckout.mockResolvedValue({ checkoutId: "co_exp", raw: {} })
    const svc = makeService()
    await svc.initiatePayment({
      amount: 1400 as any,
      currency_code: "zar",
      data: { session_id: "payses_exp", requiresShipping: true },
    } as any)
    expect(mockCreateCheckout.mock.calls[0][0].requiresShipping).toBe(true)
  })
})

describe("PeachProviderService.authorizePayment", () => {
  it("maps a success result.code to 'captured' when the amount matches", async () => {
    mockGetStatus.mockResolvedValue({
      resultCode: "000.100.110",
      resultDescription: "ok",
      transactionId: "tx_1",
      amount: "1400.00",
      raw: {},
    })
    const svc = makeService()
    const out = await svc.authorizePayment({
      data: { checkoutId: "co_1", amount: "1400.00" },
    } as any)
    expect(out.status).toBe("captured")
    expect(out.data).toMatchObject({
      checkoutId: "co_1",
      resultCode: "000.100.110",
      transactionId: "tx_1",
    })
  })

  // ── Amount-integrity gate (money-safety). A success code alone must NOT complete. ──
  it("returns 'error' on a success code when the Peach amount MISMATCHES the session amount", async () => {
    mockGetStatus.mockResolvedValue({
      resultCode: "000.100.110", // Peach says success…
      amount: "1.00", // …but only 1.00 was captured
      transactionId: "tx_1",
      raw: {},
    })
    const svc = makeService()
    const out = await svc.authorizePayment({
      data: { checkoutId: "co_1", amount: "1400.00" }, // session was for 1400.00
    } as any)
    expect(out.status).toBe("error")
  })

  it("returns 'error' on a success code when the Peach amount is MISSING (fail closed)", async () => {
    mockGetStatus.mockResolvedValue({
      resultCode: "000.100.110",
      transactionId: "tx_1",
      raw: {}, // no amount at all
    })
    const svc = makeService()
    const out = await svc.authorizePayment({
      data: { checkoutId: "co_1", amount: "1400.00" },
    } as any)
    expect(out.status).toBe("error")
  })

  it("does NOT amount-gate a non-success outcome (e.g. pending passes through)", async () => {
    mockGetStatus.mockResolvedValue({ resultCode: "000.200.000", raw: {} })
    const svc = makeService()
    const out = await svc.authorizePayment({
      data: { checkoutId: "co_1", amount: "1400.00" },
    } as any)
    expect(out.status).toBe("pending")
  })

  it("returns 'error' when no checkoutId is present (no status call)", async () => {
    const svc = makeService()
    const out = await svc.authorizePayment({ data: {} } as any)
    expect(out.status).toBe("error")
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it("returns 'pending' (does NOT crash) when getStatus throws", async () => {
    mockGetStatus.mockRejectedValue(new Error("network down"))
    const svc = makeService()
    const out = await svc.authorizePayment({ data: { checkoutId: "co_1" } } as any)
    expect(out.status).toBe("pending")
    expect(out.data).toMatchObject({ checkoutId: "co_1" })
  })
})

describe("PeachProviderService.getPaymentStatus", () => {
  it("returns 'pending' (does NOT throw a 500) when getStatus fails", async () => {
    mockGetStatus.mockRejectedValue(new Error("peach 503"))
    const svc = makeService()
    const out = await svc.getPaymentStatus({ data: { checkoutId: "co_1" } } as any)
    expect(out.status).toBe("pending")
    expect(out.data).toMatchObject({ checkoutId: "co_1" })
  })

  it("returns 'pending' with no checkoutId (nothing to query)", async () => {
    const svc = makeService()
    const out = await svc.getPaymentStatus({ data: {} } as any)
    expect(out.status).toBe("pending")
    expect(mockGetStatus).not.toHaveBeenCalled()
  })
})

describe("PeachProviderService.retrievePayment (no raw PII spread)", () => {
  it("whitelists safe fields and does NOT leak raw Peach card PII into session data", async () => {
    mockGetStatus.mockResolvedValue({
      resultCode: "000.100.110",
      resultDescription: "ok",
      transactionId: "tx_1",
      raw: {
        "card.last4Digits": "4242",
        "card.holder": "Test Shopper",
        "card.bin": "424242",
        threeDS: { xid: "secret" },
      },
    })
    const svc = makeService()
    const out = await svc.retrievePayment({ data: { checkoutId: "co_1" } } as any)
    // only the whitelisted fields, plus the original input data
    expect(out.data).toMatchObject({
      checkoutId: "co_1",
      resultCode: "000.100.110",
      transactionId: "tx_1",
    })
    // none of the raw PII keys leaked through
    for (const leaked of ["card.last4Digits", "card.holder", "card.bin", "threeDS"]) {
      expect((out.data as Record<string, unknown>)[leaked]).toBeUndefined()
    }
  })

  it("returns data unchanged (does NOT throw) when getStatus fails", async () => {
    mockGetStatus.mockRejectedValue(new Error("peach 503"))
    const svc = makeService()
    const out = await svc.retrievePayment({ data: { checkoutId: "co_1", amount: "1400.00" } } as any)
    expect(out.data).toMatchObject({ checkoutId: "co_1", amount: "1400.00" })
  })
})

describe("PeachProviderService.updatePayment (amount-locked checkouts)", () => {
  it("reuses the existing checkout when the amount is unchanged (no re-mint)", async () => {
    const svc = makeService()
    const out = await svc.updatePayment({
      amount: 15000 as any,
      data: { checkoutId: "co_existing", amount: "15000.00", session_id: "payses_x" },
    } as any)
    expect(out.status).toBe("pending")
    expect((out.data as any).checkoutId).toBe("co_existing")
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it("re-mints a fresh checkout when the amount changed", async () => {
    mockCreateCheckout.mockResolvedValue({ checkoutId: "co_new", redirectUrl: "https://secure/new", raw: {} })
    const svc = makeService()
    const out = await svc.updatePayment({
      amount: 20000 as any,
      currency_code: "zar",
      data: { checkoutId: "co_old", amount: "15000.00", session_id: "payses_x" },
    } as any)
    expect(mockCreateCheckout).toHaveBeenCalledTimes(1)
    expect((out.data as any).checkoutId).toBe("co_new")
    expect((out.data as any).amount).toBe("20000.00")
  })
})

describe("PeachProviderService.refundPayment", () => {
  it("happy path: calls client.refund(transactionId, amount, currency) and records lastRefund", async () => {
    mockRefund.mockResolvedValue({ "result.code": "000.000.000", id: "rf_1" })
    const svc = makeService()
    const out = await svc.refundPayment({
      amount: 5000 as any,
      data: { transactionId: "tx_orig", checkoutId: "co_1", currency: "ZAR" },
    } as any)

    expect(mockRefund).toHaveBeenCalledWith("tx_orig", "5000.00", "ZAR")
    expect((out.data as any).lastRefund).toMatchObject({
      amount: "5000.00",
      result: { "result.code": "000.000.000", id: "rf_1" },
    })
    expect((out.data as any).lastRefund.at).toEqual(expect.any(String))
  })

  it("THROWS (does NOT fall back to checkoutId) when no transactionId is present", async () => {
    // Sending the checkoutId as the V1 refund `id` mis-targets the refund. Fail loud instead.
    const svc = makeService()
    const err = await svc
      .refundPayment({ amount: 100 as any, data: { checkoutId: "co_fallback", currency: "ZAR" } } as any)
      .then(() => null)
      .catch((e: any) => e)
    expect(err).toBeInstanceOf(MedusaError)
    expect(err.message).toMatch(/no Peach transaction id|32-char/)
    expect(mockRefund).not.toHaveBeenCalled()
  })

  it("PROPAGATES a refund rejection as a friendly MedusaError (a failed refund is NOT recorded as success)", async () => {
    mockRefund.mockRejectedValue(new Error("Peach refund not successful (result.code=800.100.153)"))
    const svc = makeService()
    const err = await svc
      .refundPayment({ amount: 5000 as any, data: { transactionId: "tx_orig", currency: "ZAR" } } as any)
      .then(() => null)
      .catch((e: any) => e)
    expect(err).toBeInstanceOf(MedusaError)
    // staff-actionable message that still carries the underlying Peach detail
    expect(err.message).toMatch(/could not be processed by Peach and was NOT recorded/)
    expect(err.message).toMatch(/not successful|800\.100/)
    // the message is currency-neutral: "<amount> <currency>", no hardcoded symbol
    expect(err.message).toMatch(/Refund of 5000\.00 ZAR/)
  })
})
