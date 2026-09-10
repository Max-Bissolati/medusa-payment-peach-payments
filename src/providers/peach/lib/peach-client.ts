import crypto from "crypto"
import { Logger } from "@medusajs/framework/types"
import { PeachCheckoutResult, PeachMode, PeachOptions, PeachStatusResult } from "../types"
import { isSuccessful } from "./result-codes"

interface Hosts {
  /** OAuth token service. */
  auth: string
  /** Checkout V2 API. */
  checkout: string
  /** V1 API (refunds are still V1). */
  apiV1: string
  /** Browser SDK script (checkout.js). */
  sdk: string
}

export const PEACH_HOSTS: Record<PeachMode, Hosts> = {
  sandbox: {
    auth: "https://sandbox-dashboard.peachpayments.com",
    checkout: "https://testsecure.peachpayments.com",
    apiV1: "https://testapi.peachpayments.com",
    sdk: "https://sandbox-checkout.peachpayments.com/js/checkout.js",
  },
  production: {
    auth: "https://dashboard.peachpayments.com",
    checkout: "https://secure.peachpayments.com",
    apiV1: "https://api.peachpayments.com",
    sdk: "https://checkout.peachpayments.com/js/checkout.js",
  },
}

export interface CreateCheckoutArgs {
  amount: string
  currency: string
  merchantTransactionId: string
  /** Medusa PaymentSession id: echoed back via customParameters for webhook mapping. */
  sessionId?: string
  customer?: {
    email?: string | null
    first_name?: string | null
    last_name?: string | null
    phone?: string | null
    billing_address?: Record<string, unknown> | null
  } | null
  /** Pin a single method (e.g. for hosted-redirect buttons). */
  defaultPaymentMethod?: string
  forceDefaultMethod?: boolean
  /** Tokenise the card for one-click reuse (cards only). */
  createRegistration?: boolean
  /** Cart id: appended to shopperResultUrl so a cross-browser 3DS return can recover the cart. */
  cartId?: string
  /**
   * Embedded Express (Apple/Google Pay): ask the wallet sheet to collect the shopper's
   * postal address + contact, surfaced later on /status as shipping.* / customer.*.
   * Pre-GA field; harmless if the entity ignores it.
   */
  requiresShipping?: boolean
}

export class PeachClient {
  private readonly options: PeachOptions
  private readonly logger: Logger
  readonly hosts: Hosts
  readonly mode: PeachMode
  readonly sdkUrl: string

  private tokenCache?: { token: string; expiresAt: number }

  constructor(options: PeachOptions, logger: Logger) {
    this.options = options
    this.logger = logger
    this.mode = options.mode === "production" ? "production" : "sandbox"
    this.hosts = PEACH_HOSTS[this.mode]
    this.sdkUrl = this.hosts.sdk
  }

  // ───────────────────────────── OAuth ─────────────────────────────

  /** Bearer token, cached until expiry (−60s safety buffer). */
  async getToken(): Promise<string> {
    const now = Date.now()
    if (this.tokenCache && now < this.tokenCache.expiresAt) {
      return this.tokenCache.token
    }
    this.requireCreds()

    const res = await fetch(`${this.hosts.auth}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        merchantId: this.options.merchantId,
      }),
    })

    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    if (!res.ok || !json.access_token) {
      throw new Error(
        `Peach OAuth token request failed (${res.status}): ${JSON.stringify(json)}`
      )
    }

    const ttlSeconds = Number(json.expires_in ?? 3600)
    this.tokenCache = {
      token: json.access_token as string,
      expiresAt: now + Math.max(ttlSeconds - 60, 30) * 1000,
    }
    return this.tokenCache.token
  }

  /** Force-clear the cached token (used to retry once on a 401). */
  clearToken(): void {
    this.tokenCache = undefined
  }

  // ──────────────────────────── Checkout ───────────────────────────

  async createCheckout(args: CreateCheckoutArgs): Promise<PeachCheckoutResult> {
    const baseResultUrl =
      this.options.shopperResultUrl || `${this.options.referer || ""}/checkout/peach-result`
    // Carry the cart id in the return URL so a cross-browser / mobile-bank-app 3DS return
    // (where localStorage is unavailable) can still recover the cart from the query string.
    const shopperResultUrl = args.cartId
      ? `${baseResultUrl}${baseResultUrl.includes("?") ? "&" : "?"}cartId=${encodeURIComponent(
          args.cartId
        )}`
      : baseResultUrl

    const body: Record<string, unknown> = {
      authentication: { entityId: this.options.entityId },
      merchantTransactionId: args.merchantTransactionId,
      amount: args.amount,
      currency: args.currency,
      nonce: crypto.randomUUID(),
      paymentType: this.options.paymentType || "DB",
      shopperResultUrl,
    }

    if (args.sessionId) {
      body.customParameters = { medusaSessionId: args.sessionId }
    }
    if (this.options.notificationUrl) {
      body.notificationUrl = this.options.notificationUrl
    }
    if (this.options.cancelUrl) {
      body.cancelUrl = this.options.cancelUrl
    }
    if (this.options.merchantName) {
      body.merchant = { name: this.options.merchantName }
    }
    if (args.defaultPaymentMethod) {
      body.defaultPaymentMethod = args.defaultPaymentMethod
      if (args.forceDefaultMethod) {
        body.forceDefaultMethod = true
      }
    }
    if (args.createRegistration) {
      body.createRegistration = true
    }
    if (args.requiresShipping) {
      body.requiresShipping = true
    }
    if (args.customer) {
      const c = args.customer
      const customer: Record<string, unknown> = {}
      if (c.email) customer.email = c.email
      if (c.first_name) customer.givenName = c.first_name
      if (c.last_name) customer.surname = c.last_name
      if (Object.keys(customer).length) body.customer = customer

      const a = c.billing_address as Record<string, any> | null | undefined
      if (a) {
        // Country: the address's own country_code, else the configured default.
        // With neither, OMIT the field entirely (never guess a country).
        const country = (a.country_code || this.options.defaultCountryCode || "")
          .toString()
          .toUpperCase()
        body.billing = {
          street1: a.address_1,
          street2: a.address_2 || undefined,
          city: a.city,
          state: a.province,
          postcode: a.postal_code,
          ...(country ? { country } : {}),
        }
      }
    }

    const json = await this.authedFetch(`${this.hosts.checkout}/v2/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    const checkoutId = json.checkoutId as string | undefined
    if (!checkoutId) {
      throw new Error(`Peach /v2/checkout returned no checkoutId: ${JSON.stringify(json)}`)
    }
    return { checkoutId, redirectUrl: json.redirectUrl as string | undefined, raw: json }
  }

  async getStatus(checkoutId: string): Promise<PeachStatusResult> {
    const json = await this.authedFetch(
      `${this.hosts.checkout}/v2/checkout/${encodeURIComponent(checkoutId)}/status`,
      { method: "GET" }
    )

    // Status responses vary by endpoint. The V2 /status endpoint returns a FLAT
    // object with dotted string keys (e.g. `json["result.code"] = "000.100.110"`,
    // `json["customParameters[medusaSessionId]"]`), NOT nested objects. Other
    // shapes nest under `result`/`payment`. Read every known shape so a success
    // code is never missed (a missed code maps to "pending" -> cart.complete 400).
    const payment = (json.payment || json.payments?.[0] || {}) as Record<string, any>
    const result = (json.result || json.payment?.result || payment.result || {}) as Record<string, any>
    const custom = (json.customParameters || payment.customParameters || {}) as Record<string, any>

    const resultCode =
      json["result.code"] ?? result.code ?? json.payments?.[0]?.result?.code ?? json.resultCode
    const resultDescription =
      json["result.description"] ??
      result.description ??
      json.payments?.[0]?.result?.description ??
      json.resultDescription
    // Peach amount can sit at the top level (flat) or on the (first) payment object.
    const amountRaw = json["amount"] ?? json.amount ?? payment.amount
    const amount = amountRaw !== undefined && amountRaw !== null ? String(amountRaw) : undefined

    // A 200 /status with no result code means we can't classify the outcome: surface it
    // so a silent "pending" (which stalls cart.complete) is diagnosable.
    if (!resultCode) {
      this.logger.warn(
        `[peach] /status for ${checkoutId} returned 200 with no result code: cannot classify (keys: ${Object.keys(
          json
        ).join(",")}).`
      )
    }

    // Wallet address + contact (Embedded Express with requiresShipping). Same shape
    // variability as result.code above: read BOTH flat dotted keys (`json["shipping.street1"]`)
    // and nested objects (`json.shipping.street1`). Absent/blank fields are OMITTED so
    // downstream never sees empty strings, and the keys are whitelisted (no raw spread).
    const readGroup = <K extends string>(
      nested: unknown,
      prefix: string,
      keys: readonly K[]
    ): Partial<Record<K, string>> | undefined => {
      const obj = (nested && typeof nested === "object" ? nested : {}) as Record<string, unknown>
      const out: Partial<Record<K, string>> = {}
      for (const k of keys) {
        const v = obj[k] ?? json[`${prefix}.${k}`]
        if ((typeof v === "string" && v.trim() !== "") || typeof v === "number") {
          out[k] = String(v)
        }
      }
      return Object.keys(out).length ? out : undefined
    }
    const shipping = readGroup(json.shipping, "shipping", [
      "street1",
      "city",
      "state",
      "postcode",
      "country",
    ] as const)
    const customerInfo = readGroup(json.customer, "customer", [
      "givenName",
      "surname",
      "mobile",
      "email",
    ] as const)

    return {
      resultCode,
      resultDescription,
      transactionId: json.id ?? payment.id ?? json.paymentId,
      amount,
      medusaSessionId:
        json["customParameters[medusaSessionId]"] ?? custom.medusaSessionId,
      ...(shipping ? { shipping } : {}),
      ...(customerInfo ? { customer: customerInfo } : {}),
      raw: json,
    }
  }

  // ───────────────────────────── Refund (V1, HMAC) ─────────────────
  // V1 refund signing verified against Peach's sandbox: partial and full refunds succeed
  // and update payment_collection.refunded_amount. Refunds MUST be
  // application/x-www-form-urlencoded flat keys (nested JSON → 200.300.404), and a
  // declined refund returns HTTP 200 with a non-success result.code: which this method
  // throws on (see below) so a failed refund is never recorded as success.

  async refund(transactionId: string, amount: string, currency?: string): Promise<Record<string, any>> {
    if (!this.options.secretToken) {
      throw new Error("Peach refund requires the secretToken option (HMAC): not configured.")
    }
    if (!transactionId) {
      throw new Error("Peach refund requires the original payment transaction id.")
    }
    // Uppercase before signing: the currency is part of the signed V1 message, so a
    // lowercase "zar" would both fail Peach validation and produce a different signature.
    const resolvedCurrency = (currency || this.options.defaultCurrency || "").toUpperCase()
    if (!resolvedCurrency) {
      throw new Error(
        "Peach refund has no currency: none was supplied and no defaultCurrency option is configured."
      )
    }
    if (!/^[A-Z]{3}$/.test(resolvedCurrency)) {
      throw new Error(
        `Peach refund has an invalid currency "${resolvedCurrency}": expected a 3-letter ISO code like "ZAR".`
      )
    }
    const token = await this.getToken()
    // The transaction id goes in the BODY as `id` (NOT the URL path); entityId is nested
    // under `authentication`. For SIGNING, the entityId key is the literal string
    // "authentication.entityId" (per Peach's refund documentation).
    const signParams: Record<string, string> = {
      amount,
      "authentication.entityId": this.options.entityId || "",
      currency: resolvedCurrency,
      id: transactionId,
      paymentType: "RF",
    }
    const signature = this.signV1(signParams)

    // The V1 (classic OPPWA) refund endpoint expects application/x-www-form-urlencoded
    // with FLAT dotted keys (`authentication.entityId`), NOT nested JSON: sending JSON
    // makes Peach see `authentication.entityId` as null (200.300.404). The body keys must
    // match the signed params exactly (plus `signature`).
    const form = new URLSearchParams({ ...signParams, signature })

    const res = await fetch(`${this.hosts.apiV1}/v1/checkout/refund`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...this.allowlistHeaders(),
      },
      body: form.toString(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    if (!res.ok) {
      throw new Error(`Peach refund failed (${res.status}): ${JSON.stringify(json)}`)
    }
    // Peach V1 returns HTTP 200 even for a DECLINED refund: the outcome is in result.code.
    // Validate it so a declined refund is never silently recorded as successful.
    const code = (json["result.code"] ?? json.result?.code) as string | undefined
    if (!isSuccessful(code)) {
      throw new Error(
        `Peach refund not successful (result.code=${code}): ${json["result.description"] ?? json.result?.description ?? ""}`
      )
    }
    return json
  }

  /**
   * V1 HMAC signature: params sorted alphabetically by key, concatenated as `key` + `value`
   * with NO separator (no `=`, no `&`), signed with the secret token (hex). Confirmed against
   * Peach docs: e.g. `amount5.00authentication.entityId8ac7..currencyZARid8ac7..paymentTypeRF`.
   */
  private signV1(params: Record<string, string>): string {
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join("")
    return crypto
      .createHmac("sha256", this.options.secretToken as string)
      .update(message, "utf8")
      .digest("hex")
  }

  /**
   * Peach's domain allowlist validates the `Origin` AND `Referer` headers on `/v2/checkout`.
   * Origin has NO trailing slash; Referer HAS a trailing slash.
   */
  private allowlistHeaders(): Record<string, string> {
    const base = (this.options.referer || "").replace(/\/+$/, "")
    if (!base) {
      return {}
    }
    return { Origin: base, Referer: `${base}/` }
  }

  // ───────────────────────────── helpers ───────────────────────────

  /** Authenticated JSON fetch with a single token-refresh retry on 401. */
  private async authedFetch(
    url: string,
    init: RequestInit,
    retry = true
  ): Promise<Record<string, any>> {
    const token = await this.getToken()
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
        ...this.allowlistHeaders(),
      },
    })

    if (res.status === 401 && retry) {
      this.clearToken()
      return this.authedFetch(url, init, false)
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    if (!res.ok) {
      throw new Error(`Peach request failed ${init.method} ${url} (${res.status}): ${JSON.stringify(json)}`)
    }
    return json
  }

  private requireCreds(): void {
    const missing: string[] = []
    if (!this.options.clientId) missing.push("PEACH_CLIENT_ID")
    if (!this.options.clientSecret) missing.push("PEACH_CLIENT_SECRET")
    if (!this.options.merchantId) missing.push("PEACH_MERCHANT_ID")
    if (!this.options.entityId) missing.push("PEACH_ENTITY_ID")
    if (missing.length) {
      throw new Error(
        `Peach Payments is not configured: missing: ${missing.join(", ")}. ` +
          `See the medusa-payment-peach-payments README for required options.`
      )
    }
  }
}
