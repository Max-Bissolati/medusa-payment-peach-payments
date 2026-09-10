import { PaymentActions, PaymentSessionStatus } from "@medusajs/framework/types"
import { PeachResultCodeOverrides } from "../types"

/**
 * Peach / OPPWA result-code -> Medusa status mapping.
 *
 * Patterns verified against Peach's published result-code documentation.
 *
 * Buckets:
 *  - SUCCESS            transaction succeeded                 -> captured (we use paymentType DB)
 *  - SUCCESS_REVIEW     succeeded, flagged for manual review  -> captured
 *  - PENDING            async / pending                       -> pending
 *  - PENDING_EXTERNAL   waiting on external (e.g. EFT/BNPL)   -> pending
 *  - REQUIRES_MORE      SCA / soft-decline / timeout          -> requires_more
 *  - everything else                                          -> error
 */
// SUCCESS: 000.000.* (approved), 000.100.1* (successfully processed: NOT the
// 000.100.2xx chargeback/reversal family), 000.3xx/000.6xx (manual review / chargeback
// handling that still settles as captured for DB).
const SUCCESS = /^(000\.000\.|000\.100\.1|000\.[36])/
// SUCCESS_REVIEW (000.400.* band): the 000.400.0xx approvals (except 000.400.03x) plus
// ONLY 000.400.100 (review-success) and 000.400.110/120 (auth-success). Everything else in
// 000.400.1xx falls through to `error`. The third-segment class is digits-only
// ([0-24-9], i.e. 0-9 except 3): a non-digit like "000.400.0X" must never bucket as success.
// 000.400.101 ("card not participating/authentication unavailable") and 000.400.102 ("user
// not enrolled") are DELIBERATELY NOT success. Verified against Peach's published
// result-code documentation: both file under "Rejected", and in the server-to-server flow
// they are intermediate 3DS-step codes (the gateway then submits the DB/PA and the DEBIT's
// own result code decides capture). For Checkout V2 a real success returns a terminal
// 000.100.1* code, so treating 101/102 as captured is fail-open; mapping them to error
// declines no legitimate payment. Merchants who disagree can use resultCodeOverrides.
const SUCCESS_REVIEW = /^(000\.400\.0[0-24-9]|000\.400\.100|000\.400\.1[12]0)/
const PENDING = /^(000\.200)/
const PENDING_EXTERNAL = /^(800\.400\.5|100\.400\.500)/
const REQUIRES_MORE = /^(300\.100\.100|900\.100\.[34])/
// 100.396.101 = cancelled by user, 100.396.104 = uncertain/probably-cancelled.
// Map to `canceled` so Medusa's webhook subscriber SKIPS it (never downgrades an
// already-authorised order on a late, out-of-order cancel/uncertain webhook).
const CANCELLED = /^(100\.396\.101|100\.396\.104)/

// A real Peach/OPPWA result code is exactly three dot-separated 3-digit groups.
// Matching the FULL token (not just a prefix) means junk like "000.000.000extra"
// or a code with a trailing newline can never bucket as success.
const CODE_SHAPE = /^\d{3}\.\d{3}\.\d{3}$/

function builtinStatus(code: string): PaymentSessionStatus {
  if (!CODE_SHAPE.test(code)) {
    return "error"
  }
  if (SUCCESS.test(code) || SUCCESS_REVIEW.test(code)) {
    return "captured"
  }
  if (PENDING.test(code) || PENDING_EXTERNAL.test(code)) {
    return "pending"
  }
  if (REQUIRES_MORE.test(code)) {
    return "requires_more"
  }
  if (CANCELLED.test(code)) {
    return "canceled"
  }
  return "error"
}

// Warn once per overridden code that upgrades a fail-closed default to success.
const warnedOverrides = new Set<string>()

export function mapResultCodeToStatus(
  code?: string | null,
  overrides?: PeachResultCodeOverrides
): PaymentSessionStatus {
  if (!code) {
    return "pending"
  }
  // Reject codes containing ANY whitespace (leading, trailing, or embedded) before
  // override/bucket matching: "000.000.000\n<junk>" must never map to success, and a
  // padded code is not a real Peach code. Fail closed to error.
  if (/\s/.test(code)) {
    return "error"
  }
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, code)) {
    const overridden = overrides[code]
    if (
      (overridden === "authorized" || overridden === "captured") &&
      builtinStatus(code) === "error" &&
      !warnedOverrides.has(code)
    ) {
      warnedOverrides.add(code)
      // eslint-disable-next-line no-console
      console.warn(
        `[peach] resultCodeOverrides maps ${code} to "${overridden}", but the built-in map ` +
          `treats it as a decline/error (fail closed). Make sure this override is intentional.`
      )
    }
    return overridden
  }
  return builtinStatus(code)
}

export function mapResultCodeToAction(
  code?: string | null,
  overrides?: PeachResultCodeOverrides
): PaymentActions {
  switch (mapResultCodeToStatus(code, overrides)) {
    case "captured":
      return "captured"
    case "authorized":
      return "authorized"
    case "pending":
      return "pending"
    case "requires_more":
      return "requires_more"
    case "canceled":
      return "canceled"
    default:
      return "failed"
  }
}

/** True if the code represents a final, successful (money-taken) outcome. */
export function isSuccessful(
  code?: string | null,
  overrides?: PeachResultCodeOverrides
): boolean {
  const status = mapResultCodeToStatus(code, overrides)
  return status === "captured" || status === "authorized"
}
