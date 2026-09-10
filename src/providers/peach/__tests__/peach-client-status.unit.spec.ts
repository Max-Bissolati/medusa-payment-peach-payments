import { PeachClient } from "../lib/peach-client"
import { PeachOptions } from "../types"

const logger = { info: () => {}, warn: () => {}, error: () => {} } as any

const OPTS: PeachOptions = {
  mode: "sandbox",
  clientId: "cid",
  clientSecret: "csecret",
  merchantId: "mid",
  entityId: "ent_123",
  referer: "https://store.example.com",
}

type Resp = { ok?: boolean; status?: number; body: any }

function mockFetchQueue(responses: Resp[]) {
  const calls: { url: string; init: any }[] = []
  const fn = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init })
    const r = responses.shift()
    if (!r) throw new Error(`unexpected fetch to ${url}`)
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body } as any
  })
  ;(global as any).fetch = fn
  return { fn, calls }
}

const TOKEN_OK: Resp = { body: { access_token: "tok_abc", expires_in: 3600 } }

afterEach(() => {
  jest.restoreAllMocks()
  delete (global as any).fetch
})

// ── Regression: the V2 /status endpoint returns a FLAT object with dotted string keys
//    (NOT nested `result`/`payment` objects). The original parser only read the nested
//    shape, so a success code came back undefined -> mapped to "pending" -> cart.complete
//    400 -> perpetual pending. getStatus must read the flat dotted keys too. ──
describe("PeachClient.getStatus: FLAT dotted-key shape (perpetual-pending regression)", () => {
  it("parses result.code / id / medusaSessionId / result.description from flat keys", async () => {
    mockFetchQueue([
      TOKEN_OK,
      {
        body: {
          "result.code": "000.100.110",
          id: "TXN000000000TEST",
          "customParameters[medusaSessionId]": "payses_123",
          "result.description": "ok",
        },
      },
    ])
    const client = new PeachClient(OPTS, logger)
    const s = await client.getStatus("co_flat")

    expect(s.resultCode).toBe("000.100.110")
    expect(s.transactionId).toBe("TXN000000000TEST")
    expect(s.medusaSessionId).toBe("payses_123")
    expect(s.resultDescription).toBe("ok")
    // raw is preserved verbatim for downstream amount confirmation.
    expect((s.raw as any)["result.code"]).toBe("000.100.110")
  })

  it("a flat success code maps to 'captured' (not 'pending')", async () => {
    // Guards the exact failure mode: a success that parsed as undefined would map to pending.
    const { mapResultCodeToStatus } = require("../lib/result-codes")
    mockFetchQueue([TOKEN_OK, { body: { "result.code": "000.100.110", id: "tx_1" } }])
    const client = new PeachClient(OPTS, logger)
    const s = await client.getStatus("co_flat2")
    expect(mapResultCodeToStatus(s.resultCode)).toBe("captured")
  })
})

// ── getStatus must expose the authoritative `amount` (used by the amount-integrity checks)
//    and read the `payments[]` result shape (else a payments[]-shaped success reads as pending). ──
describe("PeachClient.getStatus: amount extraction + payments[] result shape", () => {
  it("extracts a flat top-level amount", async () => {
    mockFetchQueue([TOKEN_OK, { body: { "result.code": "000.100.110", amount: "1400.00", id: "tx_1" } }])
    const s = await new PeachClient(OPTS, logger).getStatus("co_amt")
    expect(s.amount).toBe("1400.00")
  })

  it("extracts amount from the nested payment object", async () => {
    mockFetchQueue([TOKEN_OK, { body: { payment: { result: { code: "000.100.110" }, amount: "250.00", id: "pay_1" } } }])
    const s = await new PeachClient(OPTS, logger).getStatus("co_amt2")
    expect(s.amount).toBe("250.00")
    expect(s.resultCode).toBe("000.100.110")
    expect(s.transactionId).toBe("pay_1")
  })

  it("reads result.code / description from the payments[] shape (was mapped as pending before)", async () => {
    const { mapResultCodeToStatus } = require("../lib/result-codes")
    mockFetchQueue([
      TOKEN_OK,
      {
        body: {
          payments: [
            { result: { code: "000.100.110", description: "ok" }, id: "pay_9", amount: "999.00" },
          ],
        },
      },
    ])
    const s = await new PeachClient(OPTS, logger).getStatus("co_pays")
    expect(s.resultCode).toBe("000.100.110")
    expect(s.resultDescription).toBe("ok")
    expect(s.transactionId).toBe("pay_9")
    expect(s.amount).toBe("999.00")
    expect(mapResultCodeToStatus(s.resultCode)).toBe("captured")
  })

  it("leaves amount undefined and WARNS when a 200 /status carries no result code", async () => {
    const warn = jest.fn()
    mockFetchQueue([TOKEN_OK, { body: { id: "tx_only" } }])
    const s = await new PeachClient(OPTS, { info: () => {}, warn, error: () => {} } as any).getStatus("co_none")
    expect(s.resultCode).toBeUndefined()
    expect(s.amount).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no result code/))
  })
})

// ── Embedded Express: wallet shipping + customer on /status (requiresShipping).
//    Shape is pre-GA, so getStatus must tolerate BOTH the flat dotted-key shape
//    (`json["shipping.street1"]`) and nested objects (`json.shipping.street1`), and must
//    OMIT absent/blank fields (Peach omits blanks; we never emit empty strings). ──
describe("PeachClient.getStatus: wallet shipping + customer extraction (Embedded Express)", () => {
  it("reads NESTED shipping + customer objects", async () => {
    mockFetchQueue([
      TOKEN_OK,
      {
        body: {
          "result.code": "000.100.110",
          id: "tx_w1",
          shipping: { street1: "1 Test Street", city: "Testville", state: "WC", postcode: "8001", country: "ZA" },
          customer: { givenName: "Test", surname: "Shopper", mobile: "+27000000000", email: "t@example.com" },
        },
      },
    ])
    const s = await new PeachClient(OPTS, logger).getStatus("co_wallet_nested")
    expect(s.shipping).toEqual({
      street1: "1 Test Street",
      city: "Testville",
      state: "WC",
      postcode: "8001",
      country: "ZA",
    })
    expect(s.customer).toEqual({
      givenName: "Test",
      surname: "Shopper",
      mobile: "+27000000000",
      email: "t@example.com",
    })
  })

  it("reads FLAT dotted-key shipping + customer (same variability as result.code)", async () => {
    mockFetchQueue([
      TOKEN_OK,
      {
        body: {
          "result.code": "000.100.110",
          id: "tx_w2",
          "shipping.street1": "2 Sample Road",
          "shipping.city": "Sampleton",
          "shipping.postcode": "7600",
          "shipping.country": "ZA",
          "customer.givenName": "Sample",
          "customer.email": "s@example.com",
        },
      },
    ])
    const s = await new PeachClient(OPTS, logger).getStatus("co_wallet_flat")
    // state was absent → omitted, not an empty string.
    expect(s.shipping).toEqual({ street1: "2 Sample Road", city: "Sampleton", postcode: "7600", country: "ZA" })
    expect(s.shipping && "state" in s.shipping).toBe(false)
    expect(s.customer).toEqual({ givenName: "Sample", email: "s@example.com" })
  })

  it("omits shipping/customer entirely when /status carries none (card flow shape)", async () => {
    mockFetchQueue([TOKEN_OK, { body: { "result.code": "000.100.110", id: "tx_card", amount: "1400.00" } }])
    const s = await new PeachClient(OPTS, logger).getStatus("co_card_only")
    expect("shipping" in s).toBe(false)
    expect("customer" in s).toBe(false)
    // Existing extraction is untouched.
    expect(s.resultCode).toBe("000.100.110")
    expect(s.amount).toBe("1400.00")
  })

  it("drops blank-string fields and whole-blank groups", async () => {
    mockFetchQueue([
      TOKEN_OK,
      {
        body: {
          "result.code": "000.100.110",
          id: "tx_w3",
          shipping: { street1: "  ", city: "" }, // all blank → no shipping at all
          customer: { givenName: "Test", surname: "   " }, // blank surname omitted
        },
      },
    ])
    const s = await new PeachClient(OPTS, logger).getStatus("co_blankish")
    expect("shipping" in s).toBe(false)
    expect(s.customer).toEqual({ givenName: "Test" })
  })

  it("coerces a numeric postcode to a string", async () => {
    mockFetchQueue([
      TOKEN_OK,
      { body: { "result.code": "000.100.110", id: "tx_w4", shipping: { street1: "2 Sample Road", postcode: 8001 } } },
    ])
    const s = await new PeachClient(OPTS, logger).getStatus("co_numeric_pc")
    expect(s.shipping).toEqual({ street1: "2 Sample Road", postcode: "8001" })
  })
})
