// Reference code (not compiled or shipped with the package). When copying into your
// Medusa app, adjust this import to wherever you keep the Peach status types, or
// re-declare the two small shapes locally:
//   PeachStatusShipping { street1?, city?, state?, postcode?, country? }
//   PeachStatusCustomer { givenName?, surname?, mobile?, email? }
import { PeachStatusCustomer, PeachStatusShipping } from "../../src/providers/peach/types"

/**
 * Wallet-address → Medusa-cart-address mapping for Embedded Express (Apple/Google Pay).
 *
 * Pure functions (no I/O) so the money-adjacent mapping is unit-testable in isolation.
 * Used by POST /store/peach/apply-wallet-address to write the address the wallet sheet
 * collected (via `requiresShipping: true`) onto the cart BEFORE cart.complete.
 *
 * Safety rules enforced here:
 *  - WHITELIST: only the fields below are ever written: nothing else from Peach.
 *  - NEVER overwrite: an existing non-empty cart field always wins over the wallet value.
 *  - OMIT absent fields: a missing wallet field is never written as an empty string.
 *  - billing = shipping: wallets don't surface a separate billing address.
 */

/** The Medusa address fields a wallet write may touch. Nothing outside this list is written. */
export const WALLET_ADDRESS_FIELDS = [
  "first_name",
  "last_name",
  "phone",
  "company",
  "address_1",
  "address_2",
  "city",
  "province",
  "postal_code",
  "country_code",
] as const

export type WalletAddressField = (typeof WALLET_ADDRESS_FIELDS)[number]
export type WalletCartAddress = Partial<Record<WalletAddressField, string>>

/** Cart-update payload for updateCartWorkflow. Keys absent = not touched. */
export interface WalletCartUpdate {
  email?: string
  shipping_address?: WalletCartAddress
  billing_address?: WalletCartAddress
}

function isFilled(v: unknown): boolean {
  if (typeof v === "string") {
    return v.trim() !== ""
  }
  return v !== undefined && v !== null
}

/**
 * Map the wallet-collected /status `shipping` + `customer` onto a Medusa address shape.
 * Missing source fields are omitted. `country_code` defaults to "za" only when a shipping
 * address is actually present (a contact-only result must not fabricate an address country).
 * Adjust the default to your own store's country.
 * Returns undefined when there is nothing to map.
 */
export function mapWalletToMedusaAddress(
  shipping?: PeachStatusShipping,
  customer?: PeachStatusCustomer
): WalletCartAddress | undefined {
  const out: WalletCartAddress = {}
  if (customer?.givenName) out.first_name = customer.givenName
  if (customer?.surname) out.last_name = customer.surname
  if (customer?.mobile) out.phone = customer.mobile
  if (shipping && Object.keys(shipping).length > 0) {
    if (shipping.street1) out.address_1 = shipping.street1
    if (shipping.city) out.city = shipping.city
    if (shipping.state) out.province = shipping.state
    if (shipping.postcode) out.postal_code = shipping.postcode
    out.country_code = (shipping.country || "ZA").toLowerCase()
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Merge a wallet address into an existing cart address WITHOUT overwriting any non-empty
 * existing field. Returns the FULL merged address (existing non-empty whitelisted fields
 * carried over + wallet values only where the cart field is empty) so the write is correct
 * under both patch and replace update semantics, plus whether anything new was filled.
 */
export function mergeWalletAddress(
  existing: Record<string, unknown> | null | undefined,
  wallet: WalletCartAddress
): { address: WalletCartAddress; filled: boolean } {
  const address: WalletCartAddress = {}
  let filled = false
  for (const field of WALLET_ADDRESS_FIELDS) {
    const current = existing?.[field]
    if (isFilled(current)) {
      address[field] = String(current)
    } else if (wallet[field] !== undefined) {
      address[field] = wallet[field]
      filled = true
    }
  }
  return { address, filled }
}

/**
 * Build the updateCartWorkflow payload from a Peach /status result + the current cart:
 * `email` (from customer.email), `shipping_address`, and `billing_address` (= shipping).
 * Only fills what is currently empty on the cart; returns undefined when there is nothing
 * new to write (the caller then responds `{ applied: false }`).
 */
export function buildWalletCartUpdate(
  status: { shipping?: PeachStatusShipping; customer?: PeachStatusCustomer },
  cart: {
    email?: string | null
    shipping_address?: Record<string, unknown> | null
    billing_address?: Record<string, unknown> | null
  }
): WalletCartUpdate | undefined {
  const update: WalletCartUpdate = {}

  if (status.customer?.email && !isFilled(cart.email)) {
    update.email = status.customer.email
  }

  const wallet = mapWalletToMedusaAddress(status.shipping, status.customer)
  if (wallet) {
    const ship = mergeWalletAddress(cart.shipping_address, wallet)
    if (ship.filled) {
      update.shipping_address = ship.address
    }
    // Billing = shipping: wallets don't surface a separate billing address (matches the
    // existing checkout default). Merged against the cart's own billing address.
    const bill = mergeWalletAddress(cart.billing_address, wallet)
    if (bill.filled) {
      update.billing_address = bill.address
    }
  }

  return Object.keys(update).length > 0 ? update : undefined
}
