import crypto from "crypto"
import { AbstractPaymentProvider, BigNumber, MedusaError } from "@medusajs/framework/utils"
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"

import { PeachClient } from "./lib/peach-client"
import { amountsMatch, formatPeachAmount } from "./lib/amount"
import { mapResultCodeToAction, mapResultCodeToStatus } from "./lib/result-codes"
import { verifyPeachWebhook } from "./lib/verify-webhook"
import { PeachOptions } from "./types"

type InjectedDependencies = {
  logger: Logger
}

/**
 * Peach Payments (Checkout V2): Medusa v2 payment provider.
 *
 * Identifier "peach"; the registered key (provider_id) is `pp_peach_<id>`
 * where `<id>` is the provider id configured in medusa-config.ts.
 *
 * Completion model:
 *  - PRIMARY: authorize-on-return. Shopper returns to shopperResultUrl, the
 *    storefront calls cart.complete -> Medusa calls authorizePayment(), which
 *    polls GET /v2/checkout/{id}/status and returns the mapped status. On
 *    success Medusa creates the Payment + order.
 *  - BACKUP: webhook. Peach POSTs to /hooks/payment/pp_peach_<id>; Medusa's
 *    built-in handler calls getWebhookActionAndData() and runs the
 *    processPayment workflow (authorise/capture + complete cart) using the
 *    session_id we echoed via customParameters.
 */
class PeachProviderService extends AbstractPaymentProvider<PeachOptions> {
  static identifier = "peach"

  protected readonly logger_: Logger
  protected readonly options_: PeachOptions
  protected readonly client_: PeachClient

  constructor(container: InjectedDependencies, options: PeachOptions) {
    super(container as unknown as Record<string, unknown>, options)
    this.logger_ = container.logger
    this.options_ = options || {}
    this.client_ = new PeachClient(this.options_, this.logger_)

    if (!this.options_.clientId || !this.options_.entityId) {
      this.logger_.warn(
        "[peach] provider registered without full credentials: set the Peach options before taking payments."
      )
    }
  }

  /**
   * Credentials: lenient. Do NOT throw at boot on missing creds (that would prevent
   * the whole payment module from loading and break pp_system_default too). Missing
   * creds fail loudly at call time instead.
   *
   * resultCodeOverrides: strict. A malformed override value (e.g. "banana") would
   * otherwise pass through mapResultCodeToStatus verbatim at payment time, so it is
   * rejected at boot with the offending key/value named.
   */
  static validateOptions(options: Record<string, unknown>): void {
    const overrides = options?.resultCodeOverrides as Record<string, unknown> | undefined
    if (overrides === undefined || overrides === null) {
      return
    }
    const legal: string[] = ["authorized", "captured", "pending", "requires_more", "error", "canceled"]
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        `Peach provider option resultCodeOverrides must be an object mapping result codes to one of: ${legal.join(", ")}.`
      )
    }
    for (const [code, status] of Object.entries(overrides)) {
      if (typeof status !== "string" || !legal.includes(status)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_ARGUMENT,
          `Peach provider option resultCodeOverrides["${code}"] is "${String(status)}", which is not a valid ` +
            `Medusa payment session status. Use one of: ${legal.join(", ")}.`
        )
      }
    }
  }

  /** Unique 12-char merchantTransactionId (Peach requires 8-16 chars). */
  private makeMerchantTxnId(): string {
    return crypto.randomBytes(6).toString("hex") // 12 hex chars
  }

  /**
   * Session/refund currency, else the configured defaultCurrency. Normalised to upper
   * case at this single root (Peach expects "ZAR", Medusa stores "zar"). Throws when
   * neither exists, or when the resolved value is not a 3-letter ISO code: catching a
   * bad currency here means no checkout/refund request ever leaves with junk in it.
   */
  private resolveCurrency(fromInput: string | undefined, context: string): string {
    const currency = (fromInput || this.options_.defaultCurrency || "").toUpperCase()
    if (!currency) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `No currency for this ${context}: none was supplied and no defaultCurrency option is configured for the Peach provider.`
      )
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Invalid currency "${currency}" for this ${context}: expected a 3-letter ISO code like "ZAR".`
      )
    }
    return currency
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const amount = formatPeachAmount(input.amount)
    const currency = this.resolveCurrency(input.currency_code, "payment session")
    const sessionId = (input.data?.session_id as string) || undefined
    const merchantTransactionId = this.makeMerchantTxnId()

    const checkout = await this.client_.createCheckout({
      amount,
      currency,
      merchantTransactionId,
      sessionId,
      customer: input.context?.customer,
      defaultPaymentMethod: input.data?.defaultPaymentMethod as string | undefined,
      forceDefaultMethod: input.data?.forceDefaultMethod as boolean | undefined,
      createRegistration: input.data?.createRegistration as boolean | undefined,
      cartId: input.data?.cartId as string | undefined,
      requiresShipping: input.data?.requiresShipping as boolean | undefined,
    })

    return {
      id: checkout.checkoutId,
      status: "pending",
      data: {
        // keep what Medusa injected (incl. session_id) + everything the
        // storefront needs to render embedded / hosted (NOT secrets).
        ...input.data,
        checkoutId: checkout.checkoutId,
        redirectUrl: checkout.redirectUrl,
        entityId: this.options_.entityId,
        merchantTransactionId,
        amount,
        currency,
        sdkUrl: this.client_.sdkUrl,
        mode: this.client_.mode,
      },
    }
  }

  /** Called during cart.complete: the primary completion path. */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const checkoutId = input.data?.checkoutId as string | undefined
    if (!checkoutId) {
      return { status: "error", data: input.data }
    }
    try {
      const status = await this.client_.getStatus(checkoutId)
      const mapped = mapResultCodeToStatus(status.resultCode, this.options_.resultCodeOverrides)
      const data = {
        ...input.data,
        resultCode: status.resultCode,
        resultDescription: status.resultDescription,
        transactionId: status.transactionId,
      }
      // Design invariant: Medusa's payment module spreads provider-returned session data LAST,
      // so session.data.amount/checkoutId here are provider-derived (written by initiatePayment)
      // and trustworthy, not storefront-writable (verified against @medusajs/payment 2.13.x);
      // AuthorizePaymentInput carries no authoritative amount, hence this session.data comparison.
      // AMOUNT-INTEGRITY GATE (money-safety). A success result.code is NOT sufficient: the
      // amount Peach reports MUST equal the amount this session was created for (stored at
      // initiate). Fail CLOSED to `error` on any mismatch OR a missing Peach amount, so an
      // underpaid / amount-tampered checkout can never complete the order. This is the
      // backstop the webhook path already applies.
      if (mapped === "captured" || mapped === "authorized") {
        const expected = input.data?.amount as string | undefined
        if (!amountsMatch(status.amount, expected)) {
          this.logger_.error(
            `[peach] authorizePayment amount mismatch for ${checkoutId}: peach=${status.amount} expected=${expected}: refusing to complete.`
          )
          return { status: "error", data }
        }
      }
      return { status: mapped, data }
    } catch (e) {
      this.logger_.error(`[peach] authorizePayment status check failed: ${(e as Error).message}`)
      // Don't crash cart.complete: leave pending so it can be retried/polled.
      return { status: "pending", data: input.data }
    }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const checkoutId = input.data?.checkoutId as string | undefined
    if (!checkoutId) {
      return { status: "pending", data: input.data }
    }
    try {
      const status = await this.client_.getStatus(checkoutId)
      return {
        status: mapResultCodeToStatus(status.resultCode, this.options_.resultCodeOverrides),
        data: {
          ...input.data,
          resultCode: status.resultCode,
          resultDescription: status.resultDescription,
          transactionId: status.transactionId,
        },
      }
    } catch (e) {
      // Mirror authorizePayment: a transient /status failure must not throw out of a status
      // poll: report pending so the caller retries rather than surfacing a 500.
      this.logger_.error(`[peach] getPaymentStatus check failed: ${(e as Error).message}`)
      return { status: "pending", data: input.data }
    }
  }

  /** DB (immediate-capture) auto-captures at Peach: nothing to do here. */
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    // The V1 refund `id` MUST be the 32-char Peach payment/transaction id, NOT the checkoutId.
    // Sending the checkoutId as `id` makes Peach reject (or, worse, mis-target) the refund, so
    // fail LOUD with a staff-actionable message instead of silently substituting it.
    const transactionId = input.data?.transactionId as string | undefined
    if (!transactionId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "This payment has no Peach transaction id, so it cannot be refunded automatically. " +
          "Look up the 32-char payment id in the Peach dashboard and refund it there."
      )
    }
    const amount = formatPeachAmount(input.amount)
    const currency = this.resolveCurrency(input.data?.currency as string | undefined, "refund")
    let result: Record<string, any>
    try {
      result = await this.client_.refund(transactionId, amount, currency)
    } catch (e) {
      // The client throws on a non-2xx OR a declined result.code (Peach returns 200
      // even for a declined refund). Surface a clear, staff-actionable message instead
      // of a generic "unknown_error" 500, and DO NOT record the refund as successful.
      const detail = e instanceof Error ? e.message : String(e)
      this.logger_.error(`[peach] refundPayment failed (txn ${transactionId}): ${detail}`)
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Refund of ${amount} ${currency} could not be processed by Peach and was NOT recorded. ` +
          `Check the Peach dashboard before retrying. (Peach said: ${detail})`
      )
    }
    return {
      data: {
        ...input.data,
        lastRefund: { amount, at: new Date().toISOString(), result },
      },
    }
  }

  /** No V2 cancel endpoint: let the 30-min checkout session expire. */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: input.data }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const checkoutId = input.data?.checkoutId as string | undefined
    if (!checkoutId) {
      return { data: input.data }
    }
    try {
      const status = await this.client_.getStatus(checkoutId)
      // Whitelist only the fields we need. Do NOT spread `status.raw`: it can carry Peach card
      // PII (masked PAN, holder, BIN, 3DS artefacts) that would then be readable via the Store API.
      return {
        data: {
          ...input.data,
          resultCode: status.resultCode,
          resultDescription: status.resultDescription,
          transactionId: status.transactionId,
        },
      }
    } catch (e) {
      // Mirror authorize/getPaymentStatus: a transient /status failure must not throw out of an
      // admin-side read: return the existing data unchanged.
      this.logger_.error(`[peach] retrievePayment status check failed: ${(e as Error).message}`)
      return { data: input.data }
    }
  }

  /**
   * Peach checkouts are amount-locked at creation. If the cart amount changed,
   * mint a fresh checkout; otherwise keep the existing session.
   */
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const newAmount = formatPeachAmount(input.amount)
    if (input.data?.checkoutId && input.data?.amount === newAmount) {
      return { status: "pending", data: input.data }
    }
    const recreated = await this.initiatePayment(input as unknown as InitiatePaymentInput)
    return { status: recreated.status, data: recreated.data }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const headers = (payload.headers || {}) as Record<string, string | string[] | undefined>
    const raw = payload.rawData as unknown

    const rawBody = Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && Array.isArray((raw as any).data)
          ? Buffer.from((raw as any).data).toString("utf8")
          : ""

    const verification = verifyPeachWebhook({
      secretToken: this.options_.secretToken,
      headers,
      rawBody,
      url: this.options_.notificationUrl,
      // Medusa parses the form-urlencoded webhook into payload.data and drops the raw
      // bytes, so the verifier reconstructs the signed message from this when rawBody is empty.
      parsedData: (payload.data || undefined) as Record<string, unknown> | undefined,
    })

    if (!verification.valid) {
      this.logger_.warn(`[peach] webhook NOT verified (${verification.reason}): ignoring.`)
      return { action: "not_supported" }
    }
    this.logger_.info(`[peach] webhook verified via scheme "${verification.scheme}".`)

    const params = new URLSearchParams(rawBody)
    const data = (payload.data || {}) as Record<string, any>
    const get = (k: string): string | undefined =>
      params.get(k) ?? (data[k] as string | undefined)

    const resultCode =
      get("result.code") ?? get("resultCode") ?? (data.result?.code as string | undefined)
    const sessionId =
      params.get("customParameters[medusaSessionId]") ??
      get("medusaSessionId") ??
      (data.customParameters?.medusaSessionId as string | undefined)
    const checkoutId = get("checkoutId") ?? (data.checkoutId as string | undefined)

    if (!sessionId) {
      this.logger_.warn(
        "[peach] webhook missing customParameters[medusaSessionId]: cannot map to a Medusa session."
      )
      return { action: "not_supported" }
    }

    // Only the SUCCESS webhook should drive completion. Acting on a pending/declined/cancelled
    // webhook tries to authorize an un-authorized session: that fails and Medusa retries ~30×,
    // and a 3DS decline (which Peach reports as "pending") would never settle. Wait for success
    // (the redirect/authorize-on-return path handles everything else).
    const bodyAction = mapResultCodeToAction(resultCode, this.options_.resultCodeOverrides)
    if (bodyAction !== "authorized" && bodyAction !== "captured") {
      this.logger_.info(
        `[peach] webhook action "${bodyAction}" (result.code=${resultCode}): not acting; awaiting success.`
      )
      return { action: "not_supported" }
    }

    // Defence-in-depth: the classic `key+value` canonicalisation has no delimiters (non-injective),
    // so a captured signature could be replayed with altered body fields. Don't trust the body -
    // re-confirm the outcome AND amount against the authoritative GET /status (keyed on checkoutId).
    if (!checkoutId) {
      this.logger_.warn("[peach] success webhook without checkoutId: cannot confirm via /status; ignoring.")
      return { action: "not_supported" }
    }
    let confirmed: Awaited<ReturnType<PeachClient["getStatus"]>>
    try {
      confirmed = await this.client_.getStatus(checkoutId)
    } catch (e) {
      this.logger_.warn(`[peach] could not confirm webhook via /status (${(e as Error).message}): ignoring.`)
      return { action: "not_supported" }
    }
    const confirmedAction = mapResultCodeToAction(
      confirmed.resultCode,
      this.options_.resultCodeOverrides
    )
    if (confirmedAction !== "authorized" && confirmedAction !== "captured") {
      this.logger_.warn(
        `[peach] webhook claimed success but /status result.code=${confirmed.resultCode}: ignoring.`
      )
      return { action: "not_supported" }
    }
    // Amount is authoritative ONLY from /status. Do NOT fall back to the (replayable) body
    // amount: the classic key+value canonicalisation is non-injective, so a captured
    // signature could be replayed with an altered body amount. If /status yields no amount,
    // we cannot safely complete: fail CLOSED.
    const confirmedAmount = confirmed.amount
    if (confirmedAmount === undefined || confirmedAmount === null || confirmedAmount === "") {
      this.logger_.warn(
        `[peach] webhook /status for ${checkoutId} has no authoritative amount: ignoring (fail closed).`
      )
      return { action: "not_supported" }
    }
    // Prefer the /status session id; the body sessionId fallback is acceptable only because the
    // same checkoutId was just re-confirmed against /status above.
    const confirmedSession = confirmed.medusaSessionId ?? sessionId

    return {
      action: confirmedAction,
      data: {
        session_id: confirmedSession,
        amount: new BigNumber(Number(confirmedAmount)),
      },
    }
  }
}

export default PeachProviderService
