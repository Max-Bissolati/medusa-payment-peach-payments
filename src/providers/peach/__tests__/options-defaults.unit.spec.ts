import { MedusaError } from "@medusajs/framework/utils"
import { PeachOptions } from "../types"

// ── defaultCurrency fallback at the SERVICE level: initiatePayment and refundPayment
//    fall back to options.defaultCurrency when the session/refund has no currency, and
//    throw a clear MedusaError when neither is present (no hardcoded currency). ──

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

describe("initiatePayment: defaultCurrency fallback", () => {
  it("uses options.defaultCurrency (uppercased) when the session has no currency_code", async () => {
    mockCreateCheckout.mockResolvedValue({ checkoutId: "co_dc", raw: {} })
    const svc = makeService({ defaultCurrency: "zar" })
    const out = await svc.initiatePayment({
      amount: 100 as any,
      data: { session_id: "payses_dc" },
    } as any)
    expect(mockCreateCheckout.mock.calls[0][0].currency).toBe("ZAR")
    expect((out.data as any).currency).toBe("ZAR")
  })

  it("prefers the session currency_code over the default", async () => {
    mockCreateCheckout.mockResolvedValue({ checkoutId: "co_dc2", raw: {} })
    const svc = makeService({ defaultCurrency: "ZAR" })
    await svc.initiatePayment({
      amount: 100 as any,
      currency_code: "usd",
      data: {},
    } as any)
    expect(mockCreateCheckout.mock.calls[0][0].currency).toBe("USD")
  })

  it("throws a clear MedusaError when there is no currency_code and no defaultCurrency", async () => {
    const svc = makeService()
    const err = await svc
      .initiatePayment({ amount: 100 as any, data: {} } as any)
      .then(() => null)
      .catch((e: any) => e)
    expect(err).toBeInstanceOf(MedusaError)
    expect(err.message).toMatch(/defaultCurrency/)
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })
})

describe("refundPayment: defaultCurrency fallback", () => {
  it("uses options.defaultCurrency when the payment data carries no currency", async () => {
    mockRefund.mockResolvedValue({ "result.code": "000.000.000" })
    const svc = makeService({ defaultCurrency: "ZAR" })
    await svc.refundPayment({
      amount: 50 as any,
      data: { transactionId: "tx_dc" },
    } as any)
    expect(mockRefund).toHaveBeenCalledWith("tx_dc", "50.00", "ZAR")
  })

  it("prefers the stored session currency over the default", async () => {
    mockRefund.mockResolvedValue({ "result.code": "000.000.000" })
    const svc = makeService({ defaultCurrency: "ZAR" })
    await svc.refundPayment({
      amount: 50 as any,
      data: { transactionId: "tx_dc2", currency: "USD" },
    } as any)
    expect(mockRefund).toHaveBeenCalledWith("tx_dc2", "50.00", "USD")
  })

  it("throws a clear MedusaError when there is no currency and no defaultCurrency", async () => {
    const svc = makeService()
    const err = await svc
      .refundPayment({ amount: 50 as any, data: { transactionId: "tx_dc3" } } as any)
      .then(() => null)
      .catch((e: any) => e)
    expect(err).toBeInstanceOf(MedusaError)
    expect(err.message).toMatch(/defaultCurrency/)
    expect(mockRefund).not.toHaveBeenCalled()
  })
})

describe("currency normalization + validation (single root: resolveCurrency)", () => {
  it("refund with defaultCurrency 'zar' passes 'ZAR' to the client (the signed value)", async () => {
    mockRefund.mockResolvedValue({ "result.code": "000.000.000" })
    const svc = makeService({ defaultCurrency: "zar" })
    await svc.refundPayment({
      amount: 50 as any,
      data: { transactionId: "tx_lc" },
    } as any)
    expect(mockRefund).toHaveBeenCalledWith("tx_lc", "50.00", "ZAR")
  })

  it("refund with a lowercase stored session currency passes it uppercased", async () => {
    mockRefund.mockResolvedValue({ "result.code": "000.000.000" })
    const svc = makeService()
    await svc.refundPayment({
      amount: 50 as any,
      data: { transactionId: "tx_lc2", currency: "zar" },
    } as any)
    expect(mockRefund).toHaveBeenCalledWith("tx_lc2", "50.00", "ZAR")
  })

  it("initiatePayment throws on a non-3-letter currency BEFORE any network call", async () => {
    const svc = makeService()
    const err = await svc
      .initiatePayment({ amount: 100 as any, currency_code: "ZARR", data: {} } as any)
      .then(() => null)
      .catch((e: any) => e)
    expect(err).toBeInstanceOf(MedusaError)
    expect(err.message).toMatch(/Invalid currency "ZARR"/)
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it("refundPayment throws on a non-3-letter currency BEFORE any network call", async () => {
    const svc = makeService({ defaultCurrency: "ZARR" })
    const err = await svc
      .refundPayment({ amount: 50 as any, data: { transactionId: "tx_bad" } } as any)
      .then(() => null)
      .catch((e: any) => e)
    expect(err).toBeInstanceOf(MedusaError)
    expect(err.message).toMatch(/Invalid currency "ZARR"/)
    expect(mockRefund).not.toHaveBeenCalled()
  })
})

// defaultCountryCode is exercised at the client level (billing country fallback/omission);
// see peach-client.unit.spec.ts "billing country defaults". This spec pins the option's
// presence on the options type so a rename breaks loudly.
describe("PeachOptions: new option keys exist on the type", () => {
  it("accepts defaultCurrency, defaultCountryCode and resultCodeOverrides", () => {
    const opts: PeachOptions = {
      defaultCurrency: "ZAR",
      defaultCountryCode: "ZA",
      resultCodeOverrides: { "000.400.101": "captured" },
    }
    expect(opts.defaultCurrency).toBe("ZAR")
    expect(opts.defaultCountryCode).toBe("ZA")
    expect(opts.resultCodeOverrides!["000.400.101"]).toBe("captured")
  })
})
