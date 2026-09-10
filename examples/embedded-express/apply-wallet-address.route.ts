// Reference route (not compiled or shipped with the package). Copy it into your Medusa
// app as src/api/store/peach/apply-wallet-address/route.ts and adjust the imports:
//
//   import { PeachClient } from "medusa-payment-peach-payments/providers/peach"   // or re-export it
//   import { buildWalletCartUpdate } from "./wallet-address"             // your copy of the helper
//   import type { PeachMode, PeachOptions } from "medusa-payment-peach-payments/providers/peach"
//
// Note: the published package's exports map exposes ./providers/peach (the provider's
// index). If you need PeachClient or the option types directly, the simplest route is to
// keep your own thin copies, as this example does with the relative imports below.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { updateCartWorkflow } from "@medusajs/medusa/core-flows"

import { PeachClient } from "../../src/providers/peach/lib/peach-client"
import type { PeachMode, PeachOptions } from "../../src/providers/peach/types"
import { buildWalletCartUpdate } from "./wallet-address"

/** Registered provider key: identifier "peach" + the provider id from medusa-config.ts. */
const PEACH_PROVIDER_ID = "pp_peach_checkout"

/**
 * Same env mapping as the provider registration in medusa-config.ts, restricted to what
 * getStatus needs (OAuth + checkout host + allowlist referer). No secrets in code.
 */
function peachOptionsFromEnv(): PeachOptions {
  return {
    mode: (process.env.PEACH_MODE || "production") as PeachMode,
    clientId: process.env.PEACH_CLIENT_ID,
    clientSecret: process.env.PEACH_CLIENT_SECRET,
    merchantId: process.env.PEACH_MERCHANT_ID,
    entityId: process.env.PEACH_ENTITY_ID,
    referer: process.env.PEACH_REFERER || "https://store.example.com",
  }
}

/**
 * POST /store/peach/apply-wallet-address: Embedded Express (Apple/Google Pay) support.
 *
 * Body: { cart_id: string }. Response: { applied: boolean }.
 *
 * After the wallet sheet completes, the shopper's address lives only on Peach's
 * GET /v2/checkout/{id}/status (shipping.* / customer.*). This route copies it onto the
 * cart BEFORE cart.complete so the order has a delivery address:
 *  - resolves the cart's Peach payment session and reads its checkoutId,
 *  - fetches /status server-side (never trusts client-posted address data),
 *  - fills ONLY empty cart fields (email, shipping_address, billing_address = shipping).
 *
 * Fail-SOFT by design: "no wallet data" (or a transient /status failure) returns
 * { applied: false } with 200: it must never block cart completion, which is guarded
 * independently by authorizePayment's amount-integrity gate. Only a malformed request
 * (400) or unknown cart (404) is an error.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER)

  const { cart_id } = (req.body ?? {}) as { cart_id?: unknown }
  if (!cart_id || typeof cart_id !== "string") {
    return res.status(400).json({ message: "cart_id is required" })
  }

  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "email",
        "completed_at",
        "shipping_address.*",
        "billing_address.*",
        "payment_collection.payment_sessions.id",
        "payment_collection.payment_sessions.provider_id",
        "payment_collection.payment_sessions.status",
        "payment_collection.payment_sessions.data",
      ],
      filters: { id: cart_id },
    })
    const cart = data?.[0]
    if (!cart) {
      return res.status(404).json({ message: "Cart not found" })
    }
    if (cart.completed_at) {
      // Already an order: nothing to write, and not an error for the caller.
      return res.json({ applied: false })
    }

    const sessions = (cart.payment_collection?.payment_sessions ?? []) as {
      provider_id?: string
      status?: string
      data?: Record<string, unknown> | null
    }[]
    const peachSessions = sessions.filter(
      (s) => s?.provider_id === PEACH_PROVIDER_ID && typeof s?.data?.checkoutId === "string"
    )
    // Prefer the pending session (the one the wallet just paid); fall back to the last one.
    const session =
      peachSessions.find((s) => s.status === "pending") ?? peachSessions[peachSessions.length - 1]
    if (!session) {
      return res.json({ applied: false })
    }
    const checkoutId = session.data!.checkoutId as string

    // Server-side /status is the ONLY address source: client-posted addresses are ignored.
    const client = new PeachClient(peachOptionsFromEnv(), logger)
    const status = await client.getStatus(checkoutId)
    if (!status.shipping && !status.customer) {
      return res.json({ applied: false })
    }

    const update = buildWalletCartUpdate(status, cart)
    if (!update) {
      // Wallet returned data but every target field is already filled: never overwrite.
      return res.json({ applied: false })
    }

    await updateCartWorkflow(req.scope).run({ input: { id: cart_id, ...update } })
    return res.json({ applied: true })
  } catch (e) {
    // Fail SOFT: the caller proceeds to cart.complete regardless; payment integrity is
    // enforced elsewhere. Log loudly so a broken wallet-address path is diagnosable.
    logger.warn(
      `[peach] apply-wallet-address failed for cart ${cart_id}: ${(e as Error).message}`
    )
    return res.json({ applied: false })
  }
}
