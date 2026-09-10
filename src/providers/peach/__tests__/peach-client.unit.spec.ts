import crypto from "crypto"
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
  shopperResultUrl: "https://store.example.com/checkout/peach-result",
  notificationUrl: "https://api.example.com/hooks/payment/peach_checkout",
}

type Resp = { ok?: boolean; status?: number; body: any }

function mockFetchQueue(responses: Resp[]) {
  const calls: { url: string; init: any }[] = []
  const fn = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init })
    const r = responses.shift()
    if (!r) throw new Error(`unexpected fetch to ${url}`)
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
    } as any
  })
  ;(global as any).fetch = fn
  return { fn, calls }
}

const TOKEN_OK: Resp = { body: { access_token: "tok_abc", expires_in: 3600, token_type: "Bearer" } }

afterEach(() => {
  jest.restoreAllMocks()
  delete (global as any).fetch
})

describe("PeachClient hosts", () => {
  it("selects sandbox hosts by default and production when asked", () => {
    expect(new PeachClient({ ...OPTS, mode: "sandbox" }, logger).hosts.checkout).toContain("testsecure")
    expect(new PeachClient({ ...OPTS, mode: "production" }, logger).hosts.checkout).toBe("https://secure.peachpayments.com")
    expect(new PeachClient({ ...OPTS, mode: undefined }, logger).mode).toBe("sandbox")
    expect(new PeachClient(OPTS, logger).sdkUrl).toContain("sandbox-checkout.peachpayments.com")
  })
})

describe("OAuth token cache", () => {
  it("caches the token across calls (one token fetch for two checkouts)", async () => {
    const { fn, calls } = mockFetchQueue([
      TOKEN_OK,
      { body: { checkoutId: "co_1", redirectUrl: "https://secure/x" } },
      { body: { checkoutId: "co_2", redirectUrl: "https://secure/y" } },
    ])
    const client = new PeachClient(OPTS, logger)
    await client.createCheckout({ amount: "100.00", currency: "ZAR", merchantTransactionId: "abc123def456" })
    await client.createCheckout({ amount: "200.00", currency: "ZAR", merchantTransactionId: "abc123def457" })
    const tokenCalls = calls.filter((c) => c.url.includes("/api/oauth/token"))
    expect(tokenCalls).toHaveLength(1)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it("refreshes the token after expiry", async () => {
    const nowSpy = jest.spyOn(Date, "now")
    nowSpy.mockReturnValue(1_000_000)
    const { calls } = mockFetchQueue([
      { body: { access_token: "tok_1", expires_in: 100 } },
      { body: { checkoutId: "co_1" } },
      { body: { access_token: "tok_2", expires_in: 100 } },
      { body: { checkoutId: "co_2" } },
    ])
    const client = new PeachClient(OPTS, logger)
    await client.createCheckout({ amount: "1.00", currency: "ZAR", merchantTransactionId: "txn0000001" })
    nowSpy.mockReturnValue(1_000_000 + 200_000) // 200s later, past the 100-60s window
    await client.createCheckout({ amount: "1.00", currency: "ZAR", merchantTransactionId: "txn0000002" })
    expect(calls.filter((c) => c.url.includes("/api/oauth/token"))).toHaveLength(2)
  })

  it("throws a clear error when credentials are missing", async () => {
    mockFetchQueue([])
    const client = new PeachClient({ mode: "sandbox" }, logger)
    await expect(client.getToken()).rejects.toThrow(/PEACH_CLIENT_ID/)
  })
})

describe("createCheckout", () => {
  it("posts the correct body and returns the checkoutId", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { checkoutId: "co_xyz", redirectUrl: "https://secure/r" } }])
    const client = new PeachClient(OPTS, logger)
    const res = await client.createCheckout({
      amount: "15000.00",
      currency: "ZAR",
      merchantTransactionId: "abcdef123456",
      sessionId: "payses_01J",
    })
    expect(res.checkoutId).toBe("co_xyz")
    expect(res.redirectUrl).toBe("https://secure/r")

    const checkoutCall = calls.find((c) => c.url.endsWith("/v2/checkout"))!
    expect(checkoutCall.url).toContain("testsecure.peachpayments.com")
    expect(checkoutCall.init.headers.Authorization).toBe("Bearer tok_abc")
    // Peach allowlist validates BOTH headers: Origin (no trailing slash) + Referer (trailing slash).
    expect(checkoutCall.init.headers.Origin).toBe("https://store.example.com")
    expect(checkoutCall.init.headers.Referer).toBe("https://store.example.com/")
    const body = JSON.parse(checkoutCall.init.body)
    expect(body.authentication.entityId).toBe("ent_123")
    expect(body.amount).toBe("15000.00")
    expect(body.currency).toBe("ZAR")
    expect(body.paymentType).toBe("DB")
    expect(body.merchantTransactionId).toBe("abcdef123456")
    expect(body.customParameters.medusaSessionId).toBe("payses_01J")
    expect(typeof body.nonce).toBe("string")
    expect(body.shopperResultUrl).toContain("/checkout/peach-result")
    expect(body.notificationUrl).toContain("/hooks/payment/peach_checkout")
  })

  it("pins a method when defaultPaymentMethod is forced (hosted-redirect buttons)", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { checkoutId: "co_f" } }])
    const client = new PeachClient(OPTS, logger)
    await client.createCheckout({
      amount: "50000.00",
      currency: "ZAR",
      merchantTransactionId: "floattxn0001",
      defaultPaymentMethod: "FLOAT",
      forceDefaultMethod: true,
    })
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout"))!.init.body)
    expect(body.defaultPaymentMethod).toBe("FLOAT")
    expect(body.forceDefaultMethod).toBe(true)
  })

  it("carries cartId into shopperResultUrl as ?cartId=<encoded> (cross-browser 3DS recovery)", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { checkoutId: "co_cart" } }])
    const client = new PeachClient(OPTS, logger)
    await client.createCheckout({
      amount: "1.00",
      currency: "ZAR",
      merchantTransactionId: "carttxn0001",
      cartId: "cart_01J/weird?&",
    })
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout"))!.init.body)
    // base shopperResultUrl came with no query -> appended with `?`, value URL-encoded.
    expect(body.shopperResultUrl).toBe(
      "https://store.example.com/checkout/peach-result?cartId=cart_01J%2Fweird%3F%26"
    )
  })

  it("omits cartId from shopperResultUrl when not provided", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { checkoutId: "co_nocart" } }])
    await new PeachClient(OPTS, logger).createCheckout({
      amount: "1.00",
      currency: "ZAR",
      merchantTransactionId: "nocarttxn01",
    })
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout"))!.init.body)
    expect(body.shopperResultUrl).not.toContain("cartId")
  })

  it("sets requiresShipping on the body for Embedded Express wallet checkouts", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { checkoutId: "co_wallet" } }])
    await new PeachClient(OPTS, logger).createCheckout({
      amount: "1400.00",
      currency: "ZAR",
      merchantTransactionId: "wallettxn001",
      requiresShipping: true,
    })
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout"))!.init.body)
    expect(body.requiresShipping).toBe(true)
  })

  it("omits requiresShipping when not requested (card flow unchanged)", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { checkoutId: "co_card" } }])
    await new PeachClient(OPTS, logger).createCheckout({
      amount: "1400.00",
      currency: "ZAR",
      merchantTransactionId: "cardtxn00001",
    })
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout"))!.init.body)
    expect("requiresShipping" in body).toBe(false)
  })

  it("throws when Peach returns no checkoutId", async () => {
    mockFetchQueue([TOKEN_OK, { body: { result: { code: "600.200.500" } } }])
    const client = new PeachClient(OPTS, logger)
    await expect(
      client.createCheckout({ amount: "1.00", currency: "ZAR", merchantTransactionId: "nocheckout1" })
    ).rejects.toThrow(/no checkoutId/)
  })
})

describe("createCheckout: billing country defaults (defaultCountryCode)", () => {
  const billingArgs = (country_code?: string) => ({
    amount: "100.00",
    currency: "ZAR",
    merchantTransactionId: "billtxn00001",
    customer: {
      email: "shopper@example.com",
      first_name: "Test",
      last_name: "Shopper",
      billing_address: {
        address_1: "1 Test Street",
        city: "Testville",
        province: "TS",
        postal_code: "0000",
        ...(country_code ? { country_code } : {}),
      },
    },
  })

  it("uses the address's own country_code (uppercased) when present", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { checkoutId: "co_b1" } }])
    await new PeachClient(OPTS, logger).createCheckout(billingArgs("gb"))
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout"))!.init.body)
    expect(body.billing.country).toBe("GB")
  })

  it("falls back to the defaultCountryCode option when the address has none", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { checkoutId: "co_b2" } }])
    await new PeachClient({ ...OPTS, defaultCountryCode: "ZA" }, logger).createCheckout(billingArgs())
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout"))!.init.body)
    expect(body.billing.country).toBe("ZA")
  })

  it("OMITS the country field entirely when neither the address nor the option has one", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { checkoutId: "co_b3" } }])
    await new PeachClient(OPTS, logger).createCheckout(billingArgs())
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/v2/checkout"))!.init.body)
    expect(body.billing).toBeDefined()
    expect("country" in body.billing).toBe(false)
    // The rest of the billing address still goes through.
    expect(body.billing.street1).toBe("1 Test Street")
  })
})

describe("getStatus + 401 retry", () => {
  it("parses result.code and transaction id", async () => {
    mockFetchQueue([
      TOKEN_OK,
      { body: { result: { code: "000.000.000", description: "ok" }, payment: { id: "pay_1" }, customParameters: { medusaSessionId: "payses_9" } } },
    ])
    const client = new PeachClient(OPTS, logger)
    const s = await client.getStatus("co_1")
    expect(s.resultCode).toBe("000.000.000")
    expect(s.transactionId).toBe("pay_1")
    expect(s.medusaSessionId).toBe("payses_9")
  })

  it("retries once with a fresh token on 401", async () => {
    const { calls } = mockFetchQueue([
      TOKEN_OK, // initial token
      { ok: false, status: 401, body: { message: "expired" } }, // status call -> 401
      { body: { access_token: "tok_new", expires_in: 3600 } }, // refreshed token
      { body: { result: { code: "000.000.000" } } }, // retried status call -> 200
    ])
    const client = new PeachClient(OPTS, logger)
    const s = await client.getStatus("co_1")
    expect(s.resultCode).toBe("000.000.000")
    expect(calls.filter((c) => c.url.includes("/api/oauth/token"))).toHaveLength(2)
  })
})

describe("refund (V1, HMAC): bug-fix verification", () => {
  const REFUND_OPTS: PeachOptions = { ...OPTS, secretToken: "sek_token" }

  it("posts to /v1/checkout/refund as form-urlencoded with flat keys (id in BODY, not the URL path)", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { result: { code: "000.000.000" } } }])
    const client = new PeachClient(REFUND_OPTS, logger)
    await client.refund("txn_123", "5.00", "ZAR")

    const refundCall = calls.find((c) => c.url.includes("/v1/checkout/refund"))!
    expect(refundCall.url).toMatch(/\/v1\/checkout\/refund$/) // no id segment in the path
    expect(refundCall.url).not.toContain("txn_123")
    expect(refundCall.init.headers["Content-Type"]).toMatch(/x-www-form-urlencoded/)

    // The V1 endpoint expects form-urlencoded with FLAT dotted keys (not nested JSON).
    const body = new URLSearchParams(refundCall.init.body)
    expect(body.get("authentication.entityId")).toBe("ent_123") // flat dotted key
    expect(body.get("id")).toBe("txn_123") // the original payment transaction id
    expect(body.get("paymentType")).toBe("RF")
    expect(body.get("amount")).toBe("5.00")
    expect(typeof body.get("signature")).toBe("string")
  })

  it("signs with sorted key+value concatenation (NO '=' separator)", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { result: { code: "000.000.000" } } }])
    const client = new PeachClient(REFUND_OPTS, logger)
    await client.refund("TXN00000TEST", "5.00", "ZAR")

    const body = new URLSearchParams(calls.find((c) => c.url.includes("/v1/checkout/refund"))!.init.body)
    // sorted keys: amount, authentication.entityId, currency, id, paymentType
    const expectedMsg = "amount5.00authentication.entityIdent_123currencyZARidTXN00000TESTpaymentTypeRF"
    const expectedSig = crypto.createHmac("sha256", "sek_token").update(expectedMsg).digest("hex")
    expect(body.get("signature")).toBe(expectedSig)
  })

  it("uppercases a lowercase currency before signing and sending (zar -> ZAR)", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { result: { code: "000.000.000" } } }])
    const client = new PeachClient(REFUND_OPTS, logger)
    await client.refund("TXN00000TEST", "5.00", "zar")

    const body = new URLSearchParams(calls.find((c) => c.url.includes("/v1/checkout/refund"))!.init.body)
    expect(body.get("currency")).toBe("ZAR")
    // the SIGNED message uses the uppercased currency too
    const expectedMsg = "amount5.00authentication.entityIdent_123currencyZARidTXN00000TESTpaymentTypeRF"
    const expectedSig = crypto.createHmac("sha256", "sek_token").update(expectedMsg).digest("hex")
    expect(body.get("signature")).toBe(expectedSig)
  })

  it("throws on a malformed resolved currency (e.g. 'ZARR') before any refund call", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK])
    const client = new PeachClient({ ...REFUND_OPTS, defaultCurrency: "ZARR" }, logger)
    await expect(client.refund("txn_1", "5.00")).rejects.toThrow(/invalid currency "ZARR"/)
    expect(calls.some((c) => c.url.includes("/v1/checkout/refund"))).toBe(false)
  })

  it("uses the defaultCurrency option when no currency is supplied", async () => {
    const { calls } = mockFetchQueue([TOKEN_OK, { body: { result: { code: "000.000.000" } } }])
    const client = new PeachClient({ ...REFUND_OPTS, defaultCurrency: "ZAR" }, logger)
    await client.refund("txn_dc1", "7.00")
    const body = new URLSearchParams(calls.find((c) => c.url.includes("/v1/checkout/refund"))!.init.body)
    expect(body.get("currency")).toBe("ZAR")
  })

  it("throws clearly when no currency is supplied and no defaultCurrency is configured", async () => {
    mockFetchQueue([])
    const client = new PeachClient(REFUND_OPTS, logger)
    await expect(client.refund("txn_dc2", "7.00")).rejects.toThrow(/defaultCurrency/)
  })

  it("throws if the secret token is not configured", async () => {
    mockFetchQueue([])
    const client = new PeachClient({ ...OPTS, secretToken: undefined }, logger)
    await expect(client.refund("txn_1", "5.00", "ZAR")).rejects.toThrow(/secretToken/)
  })

  it("throws if Peach returns a non-success result.code (declined refund, HTTP 200)", async () => {
    mockFetchQueue([TOKEN_OK, { body: { "result.code": "800.100.153", "result.description": "declined" } }])
    const client = new PeachClient(REFUND_OPTS, logger)
    await expect(client.refund("txn_1", "5.00", "ZAR")).rejects.toThrow(/not successful|800\.100/)
  })
})
