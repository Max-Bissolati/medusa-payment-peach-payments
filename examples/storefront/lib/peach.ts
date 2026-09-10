// Reference code, adapt into your own storefront: this is not a dependency of
// medusa-payment-peach-payments. Adjust the provider id and the result path constant
// below to match your own medusa-config.ts registration and routing.
//
// Shared Peach Payments helpers + types for a Medusa v2 storefront checkout.

// The provider id you registered in medusa-config.ts. With identifier "peach"
// and id: "peach" (the README's example), Medusa resolves this to
// "pp_peach_peach". Change the id segment if you registered a different one.
export const PEACH_PROVIDER_ID = 'pp_peach_peach'

// Where Peach returns the shopper after paying (embedded widget completion and
// hosted-redirect both land here). Keep this in sync with shopperResultUrl in
// your provider options and with wherever you mount the page below.
export const PEACH_RESULT_PATH = '/checkout/peach-result'

// The fields the provider returns in the payment session `data`. All of these
// are safe to expose to the browser: the provider never puts secrets here.
export interface PeachSessionData {
  checkoutId?: string
  redirectUrl?: string
  entityId?: string
  merchantTransactionId?: string
  amount?: string | number
  currency?: string
  sdkUrl?: string
  mode?: string
}

// The Peach Checkout JS SDK global (loaded from the session's sdkUrl). Typed
// loosely: the SDK has no npm package, it's a script-tag global only.
export interface PeachCheckoutInstance {
  render: (selector: string) => void
  unmount?: () => void
}

export interface PeachCheckoutOptions {
  key: string
  checkoutId: string
  // Current SDK property for callbacks (onCompleted/onCancelled/onError/onExpired/...).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventHandlers?: Record<string, (...args: any[]) => void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export interface PeachCheckoutGlobal {
  initiate: (opts: PeachCheckoutOptions) => PeachCheckoutInstance
  express?: (opts: PeachCheckoutOptions) => PeachCheckoutInstance
}

declare global {
  interface Window {
    Checkout?: PeachCheckoutGlobal
  }
}

// Pick the ACTIVE Peach payment session out of a Medusa payment_collection's
// sessions array. Medusa v2 accumulates sessions: editing the cart and
// re-initiating a session leaves the old, amount-locked one in place alongside
// the fresh one. Picking the first Peach session blindly can return a stale,
// non-pending session with the wrong amount. This prefers a session that's
// still `pending` (the live one), then the last Peach session, then falls back
// to any pending session, then the last session overall.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pickActivePeachSession(sessions: any[] | null | undefined): any | null {
  if (!Array.isArray(sessions) || sessions.length === 0) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const peach = sessions.filter((s: any) => s?.provider_id === PEACH_PROVIDER_ID)
  const chosen =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    peach.find((s: any) => s?.status === 'pending') ??
    peach[peach.length - 1] ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessions.find((s: any) => s?.status === 'pending') ??
    sessions[sessions.length - 1]
  return chosen ?? null
}

// Find the active Peach payment session on a Medusa cart and return its
// (browser-safe) data. Uses pickActivePeachSession so it lands on the live
// session, not a stale accumulated one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPeachSessionData(cart: any): PeachSessionData | null {
  const session = pickActivePeachSession(cart?.payment_collection?.payment_sessions)
  const data = session?.data
  if (!data || typeof data !== 'object') return null
  return data as PeachSessionData
}

// Format a major-unit amount to the Peach amount string (exactly 2 dp).
// Mirrors the backend's formatPeachAmount rule, so a session's locked amount
// can be compared against the live cart total on the client.
export function peachAmountString(amount: number): string {
  if (!Number.isFinite(amount)) return ''
  return (Math.round(amount * 100) / 100).toFixed(2)
}

// True when the Peach session was created for the same amount the cart now
// totals. A Peach checkout is amount-locked at creation, so a false result
// means the widget would charge a stale total and the session should be
// re-initiated. Returns true (no divergence) when there's nothing reliable to
// compare yet, so this never churns a session on missing data. It's a UX
// guard for keeping display and charge in sync, not the money backstop (the
// backend's own amount-integrity check is that).
export function sessionAmountMatchesCart(
  session: PeachSessionData | null | undefined,
  cartTotal: number | null | undefined
): boolean {
  if (!session || session.amount == null) return true
  if (typeof cartTotal !== 'number' || !Number.isFinite(cartTotal)) return true
  const locked = peachAmountString(Number(session.amount))
  const live = peachAmountString(cartTotal)
  if (!locked || !live) return true
  return locked === live
}

// Fallback sandbox SDK url, used only if the session doesn't carry one yet
// (e.g. before the first payment session has been initiated).
export const SANDBOX_SDK_URL = 'https://sandbox-checkout.peachpayments.com/js/checkout.js'

// Default builder for the absolute shopperResultUrl you want Peach to return
// the shopper to.
export function buildResultUrl(): string {
  if (typeof window === 'undefined') return PEACH_RESULT_PATH
  return `${window.location.origin}${PEACH_RESULT_PATH}`
}
