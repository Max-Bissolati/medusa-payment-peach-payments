import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import PeachProviderService from "./service"

/**
 * Peach Payments (Checkout V2) payment module provider.
 * Identifier "peach"; the registered key is `pp_peach_<id>` where `<id>` is the
 * provider `id` you configure in medusa-config.ts.
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [PeachProviderService],
})

// Public types for consumers (options, result shapes, overrides), so a TS project can
// `import type { PeachOptions } from "medusa-payment-peach-payments/providers/peach"`.
export type {
  PeachMode,
  PeachOptions,
  PeachResultCodeOverrides,
  PeachCheckoutResult,
  PeachStatusResult,
  PeachStatusShipping,
  PeachStatusCustomer,
} from "./types"
