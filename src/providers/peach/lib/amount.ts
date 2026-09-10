import { BigNumber } from "@medusajs/framework/utils"
import { BigNumberInput } from "@medusajs/framework/types"

/**
 * Peach Payments amount rule (CRITICAL):
 *   the merchant's MAJOR currency unit (2-decimal currencies), as a decimal
 *   string with exactly 2 dp. 15,000.00 -> "15000.00".
 *   NO minor units, NO ×100. Medusa v2 stores amounts in the major unit already.
 */
export function formatPeachAmount(amount: BigNumberInput): string {
  const numeric =
    amount instanceof BigNumber ? amount.numeric : new BigNumber(amount).numeric

  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid Peach payment amount: ${String(amount)}`)
  }
  if (numeric < 0) {
    throw new Error(`Peach payment amount cannot be negative: ${numeric}`)
  }
  // Round to cents defensively, then force 2 dp.
  return (Math.round(numeric * 100) / 100).toFixed(2)
}

/**
 * True only when BOTH amounts are present, finite, and equal to the cent. A missing/empty/
 * non-finite value on EITHER side returns false, so callers fail CLOSED (never treat an
 * absent Peach amount as a match). Compares at cent granularity to avoid float drift.
 */
export function amountsMatch(
  a?: string | number | null,
  b?: string | number | null
): boolean {
  // Trim string inputs BEFORE the empty check: Number(" ") === 0, so a
  // whitespace-only amount would otherwise "match" 0.00 instead of failing closed.
  if (typeof a === "string") a = a.trim()
  if (typeof b === "string") b = b.trim()
  if (a === undefined || a === null || a === "" || b === undefined || b === null || b === "") {
    return false
  }
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    return false
  }
  return Math.round(na * 100) === Math.round(nb * 100)
}
