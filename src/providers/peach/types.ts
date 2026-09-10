import { PaymentSessionStatus } from "@medusajs/framework/types"

/**
 * Peach Payments (Checkout V2) provider types for Medusa v2.
 */

export type PeachMode = "sandbox" | "production"

/**
 * Merchant-supplied result-code overrides, checked before the built-in
 * result-code map. Keys are exact Peach `result.code` values (e.g.
 * "000.400.101"); values are the Medusa PaymentSessionStatus to map them to.
 */
export type PeachResultCodeOverrides = Record<string, PaymentSessionStatus>

/**
 * Options passed to the provider from `medusa-config.ts` (sourced from env).
 * Secrets must NEVER be committed: they live in the Medusa env only.
 */
export interface PeachOptions {
  /** "sandbox" (test) or "production" (live). Drives the base URLs. Default: "sandbox". */
  mode?: PeachMode
  /** OAuth client id (Console → Checkout). */
  clientId?: string
  /** OAuth client secret. SECRET. */
  clientSecret?: string
  /** OAuth merchant id. */
  merchantId?: string
  /** Checkout entity id = `authentication.entityId` + SDK `key`. (Semi-public; sent to the browser.) */
  entityId?: string
  /** HMAC signing key for webhook verification + the V1 refund endpoint. SECRET. */
  secretToken?: string
  /** Allowlisted domain sent as the `Referer` header on /v2/checkout (Peach validates this). */
  referer?: string
  /** Webhook URL registered in the Peach Console (= {MEDUSA_BACKEND_URL}/hooks/payment/pp_peach_<id>). */
  notificationUrl?: string
  /** Where Peach returns the shopper after a hosted-redirect payment. */
  shopperResultUrl?: string
  /** Where Peach sends the shopper if they cancel a hosted-redirect payment. */
  cancelUrl?: string
  /** "DB" = immediate capture; "PA" = pre-auth then capture. Default "DB". */
  paymentType?: "DB" | "PA"
  /** Display name shown on the Peach checkout. */
  merchantName?: string
  /**
   * Fallback ISO currency (e.g. "ZAR") used when a payment session or refund
   * carries no currency of its own. With no fallback and no session currency,
   * the provider throws at call time rather than guessing.
   */
  defaultCurrency?: string
  /**
   * Fallback upper-case ISO country (e.g. "ZA") for the billing address sent
   * to Peach when the Medusa address has no country_code. When unset and the
   * address has no country, the country field is omitted entirely.
   */
  defaultCountryCode?: string
  /**
   * Per-code overrides of the built-in result-code map, checked first. Mapping
   * a code the built-in map treats as an error/decline to a success status
   * logs a warning (once per code), since that loosens a fail-closed default.
   */
  resultCodeOverrides?: PeachResultCodeOverrides
}

/** Normalised result of creating a checkout. */
export interface PeachCheckoutResult {
  checkoutId: string
  redirectUrl?: string
  raw: Record<string, unknown>
}

/**
 * Wallet-collected delivery address on `/status` (Embedded Express with
 * `requiresShipping: true`). Peach omits blank fields, so every key is optional
 * and absent keys stay absent (never empty strings).
 */
export interface PeachStatusShipping {
  street1?: string
  city?: string
  /** ISO province code (e.g. "WC" for Western Cape). */
  state?: string
  postcode?: string
  /** Upper-case ISO country (e.g. "ZA"). */
  country?: string
}

/** Wallet-collected shopper contact on `/status` (Embedded Express). */
export interface PeachStatusCustomer {
  givenName?: string
  surname?: string
  mobile?: string
  email?: string
}

/** Normalised result of querying a checkout's status. */
export interface PeachStatusResult {
  /** Peach `result.code` (e.g. "000.000.000"). */
  resultCode?: string
  /** Peach `result.description`. */
  resultDescription?: string
  /** The payment transaction id (NOT the checkoutId): needed for refunds. */
  transactionId?: string
  /** Authoritative Peach amount for this checkout (major-unit string, e.g. "1400.00"). */
  amount?: string
  /** Echoed `customParameters.medusaSessionId` when available. */
  medusaSessionId?: string
  /** Wallet-collected shipping address, when the wallet sheet returned one. */
  shipping?: PeachStatusShipping
  /** Wallet-collected shopper contact, when returned. */
  customer?: PeachStatusCustomer
  raw: Record<string, unknown>
}
