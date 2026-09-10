<div align="center">

<img src="https://raw.githubusercontent.com/Max-Bissolati/medusa-payment-peach-payments/main/assets/readme/hero.svg" width="100%" alt="Medusa Payment Peach Payments. A hardened Peach Payments Checkout V2 provider for Medusa v2." />

<p>
<img src="https://img.shields.io/npm/v/medusa-payment-peach-payments?style=flat-square&color=cb3837" alt="npm version" />
<img src="https://img.shields.io/badge/Medusa-v2-000000?style=flat-square" alt="Medusa v2" />
<img src="https://img.shields.io/badge/node-%E2%89%A520-3572A5?style=flat-square" alt="Node 20+" />
<img src="https://img.shields.io/badge/tests-182%20passing-3fb950?style=flat-square" alt="182 tests passing" />
<img src="https://img.shields.io/badge/license-MIT-3fb950?style=flat-square" alt="MIT license" />
<img src="https://img.shields.io/badge/Peach%20Payments-Checkout%20V2-ff6f00?style=flat-square" alt="Peach Payments Checkout V2" />
</p>

</div>

An unofficial [Peach Payments](https://peachpayments.com) (Checkout V2) payment provider for
[Medusa v2](https://medusajs.com). It generalizes a production-grade Medusa v2 Peach integration,
carrying over the parts worth keeping: checkout creation, authorize-on-return completion with an
amount-integrity check, webhook handling that re-confirms the outcome server-to-server before trusting
it, and V1 HMAC refunds.

> **Not affiliated with, endorsed by, or supported by Peach Payments.** A community plugin maintained
> independently. For Peach API questions that are not about this plugin's code, see
> [developer.peachpayments.com](https://developer.peachpayments.com).

## Why reach for this instead of a quick custom provider

A payment provider is easy to write and easy to get subtly, expensively wrong. This one carries the guards
you would want from any integration, made explicit:

- **Amount-integrity gate.** `authorizePayment` cross-checks the amount Peach reports on `/status` against
  the amount the session was created for, and fails closed on any mismatch or a missing amount. A result
  code alone never completes an order.
- **Webhook re-confirmation.** The webhook handler never acts on the notification body's claimed outcome or
  amount. It re-fetches `/status` by `checkoutId` and treats that as the only source of truth, so the
  result is independent of anything in the (forgeable) notification.
- **Fail-closed result mapping.** `000.400.101` and `000.400.102` (3DS "not participating" and "not
  enrolled") map to `error`, not success. They are intermediate, not terminal; real Checkout V2 successes
  land on a terminal `000.100.1*` code.
- **Declined refunds are not silent.** Peach returns HTTP 200 for a *declined* refund; the provider checks
  the result code and throws rather than reporting success.
- **Two independent completion paths** (authorize-on-return **and** webhook), both converging on the same
  `/status` call, so a shopper who closes the tab before the redirect still gets their order.

## Install

```bash
npm install medusa-payment-peach-payments
```

Requirements: **Medusa v2** with `@medusajs/framework` and `@medusajs/medusa` `^2.13.0` (peer deps, not
bundled), **Node.js 20+**, and a Peach Payments merchant account with Checkout V2 access (plus a sandbox
entity for testing).

## Register

Payment providers in Medusa v2 go in the Payment module's `providers` array, not the top-level `plugins`
array. Always import the **provider subpath**. A bare package import is intentionally not exported.

```ts
import { defineConfig } from "@medusajs/framework/utils"

module.exports = defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-peach-payments/providers/peach",
            id: "peach",
            options: {
              mode: process.env.PEACH_MODE,                 // "sandbox" | "production"
              clientId: process.env.PEACH_CLIENT_ID,
              clientSecret: process.env.PEACH_CLIENT_SECRET, // secret
              merchantId: process.env.PEACH_MERCHANT_ID,
              entityId: process.env.PEACH_ENTITY_ID,         // semi-public (reaches the browser)
              secretToken: process.env.PEACH_SECRET_TOKEN,   // secret: webhook HMAC + refund HMAC
              referer: process.env.PEACH_REFERER,            // allowlisted storefront origin, no trailing slash
              notificationUrl: process.env.PEACH_NOTIFICATION_URL,
              shopperResultUrl: process.env.PEACH_SHOPPER_RESULT_URL,
              defaultCurrency: process.env.PEACH_DEFAULT_CURRENCY, // no ZAR baked in, set it yourself
            },
          },
        ],
      },
    },
  ],
})
```

The runtime provider id is `pp_<identifier>_<id>`. With `id: "peach"` that is **`pp_peach_peach`**, which
is the `provider_id` your storefront selects and the segment Medusa uses for the webhook URL. For the full,
typed option set read the JSDoc on `PeachOptions`:

```ts
import type { PeachOptions } from "medusa-payment-peach-payments/providers/peach"
```

<details>
<summary><b>All provider options (annotated) plus environment variables</b></summary>

```ts
options: {
  // "sandbox" or "production". Default "sandbox". Drives which Peach hosts the provider talks to.
  mode: process.env.PEACH_MODE,

  // OAuth credentials from the Peach Dashboard (Checkout API access).
  clientId: process.env.PEACH_CLIENT_ID,
  clientSecret: process.env.PEACH_CLIENT_SECRET,   // secret
  merchantId: process.env.PEACH_MERCHANT_ID,

  // The Checkout entity id. Doubles as `authentication.entityId` and the SDK `key` the storefront
  // passes to Checkout.initiate(), so it reaches the browser (semi-public), but do not commit it.
  entityId: process.env.PEACH_ENTITY_ID,

  // HMAC key for webhook verification AND the V1 refund endpoint. Required for refunds even if you
  // never wire up webhooks.
  secretToken: process.env.PEACH_SECRET_TOKEN,     // secret

  referer: process.env.PEACH_REFERER,              // allowlisted storefront origin, no trailing slash
  notificationUrl: process.env.PEACH_NOTIFICATION_URL,   // your webhook URL (see Webhooks)
  shopperResultUrl: process.env.PEACH_SHOPPER_RESULT_URL, // where the shopper returns after paying
  cancelUrl: process.env.PEACH_CANCEL_URL,         // hosted-redirect cancel target (not used by embedded)
  paymentType: process.env.PEACH_PAYMENT_TYPE,     // "DB" capture-now (default) or "PA" pre-auth
  merchantName: process.env.PEACH_MERCHANT_NAME,   // shown in the Peach checkout UI

  // Fallback currency, used only when a session or refund carries none. No ZAR default: with neither
  // a session currency nor a default set, the provider throws rather than guessing.
  defaultCurrency: process.env.PEACH_DEFAULT_CURRENCY,
  defaultCountryCode: process.env.PEACH_DEFAULT_COUNTRY_CODE, // ISO alpha-2 fallback, omitted if unset

  // Optional per-result-code overrides, checked before the built-in map (code only, no env var):
  //   resultCodeOverrides: { "000.400.101": "authorized" }
  // Overriding a decline or error code logs a warning once, since it loosens a fail-closed default.
}
```

| Env var | Option | Notes |
|---|---|---|
| `PEACH_MODE` | `mode` | `sandbox` or `production`, default `sandbox` |
| `PEACH_CLIENT_ID` | `clientId` | |
| `PEACH_CLIENT_SECRET` | `clientSecret` | secret |
| `PEACH_MERCHANT_ID` | `merchantId` | |
| `PEACH_ENTITY_ID` | `entityId` | reaches the browser, not a secret |
| `PEACH_SECRET_TOKEN` | `secretToken` | secret; webhook HMAC plus refund HMAC |
| `PEACH_REFERER` | `referer` | storefront origin, no trailing slash |
| `PEACH_NOTIFICATION_URL` | `notificationUrl` | your webhook URL |
| `PEACH_SHOPPER_RESULT_URL` | `shopperResultUrl` | return target after paying |
| `PEACH_CANCEL_URL` | `cancelUrl` | hosted-redirect cancel target |
| `PEACH_PAYMENT_TYPE` | `paymentType` | `DB` or `PA`, default `DB` |
| `PEACH_MERCHANT_NAME` | `merchantName` | |
| `PEACH_DEFAULT_CURRENCY` | `defaultCurrency` | fallback only, no ZAR default |
| `PEACH_DEFAULT_COUNTRY_CODE` | `defaultCountryCode` | fallback only |

</details>

## Webhooks

No custom route needed. Medusa auto-mounts `{MEDUSA_BACKEND_URL}/hooks/payment/pp_peach_<id>` for every
registered provider. With `id: "peach"`, register this URL in the Peach Dashboard as your checkout's webhook
endpoint (and set it as `notificationUrl`):

```
https://your-backend.example.com/hooks/payment/pp_peach_peach
```

Peach surfaces a signing secret when you add the webhook; that becomes your `secretToken`. You do not need a
body parser: the provider verifies the signature from the raw body when it is preserved, and reconstructs
the signed message from Medusa's already-parsed body when it is not. Verification **fails closed**: an
unverifiable webhook is ignored, never trusted. Scheme details: [`docs/WEBHOOKS.md`](docs/WEBHOOKS.md).

## Refunds

Refunds use Peach's older V1 endpoint (`POST /v1/checkout/refund`), signed with the same HMAC key as
webhooks, so `secretToken` is required even if you never receive a webhook. The refund body is **flat,
form-encoded key-value pairs** (not nested JSON) with a V1 HMAC over the sorted keys. It is a genuinely
different signing scheme from the checkout API, and an easy thing to trip over building from scratch.
Refunds need the original transaction id (not the `checkoutId`); the provider stores it on the session
after authorization and throws a clear error if it is missing rather than guessing.

## Testing in sandbox

Set `mode: "sandbox"` and use your sandbox entity. Peach's sandbox skips the success screen and
OTP/challenge prompts for known test cards (any future expiry; CVV 3 digits for Visa/Mastercard, 4 for
Amex):

| Scheme | Card number | Outcome |
|---|---|---|
| Visa | `4200000000000091` | frictionless success |
| Mastercard | `5200000000000007` | frictionless success |
| Amex | `374500262001008` | frictionless success |

Full list (challenge and decline scenarios): Peach's
[test and go-live reference](https://developer.peachpayments.com/docs/reference-test-and-go-live).

## Storefront integration

Backend-only. There is no npm storefront SDK because Peach's Checkout widget itself is a script-tag global,
not a package. [`examples/storefront/`](examples/storefront/) has reference React and Next.js code: reading
the session off the cart, mounting the embedded widget, and handling the return redirect.

## Limitations

- **Two-decimal currencies only.** Amounts are formatted and compared at 2 decimals; zero-decimal (JPY) and
  three-decimal currencies are not supported, and magnitudes beyond roughly 9e13 minor units lose float
  precision.
- **No built-in ZAR default.** Set `defaultCurrency` yourself if you want a fallback.
- **No server-side cancel.** Peach's V2 API cannot cancel a checkout; `cancelPayment` is a no-op and unpaid
  checkouts expire after 30 minutes.
- **Capture is a no-op for `DB`.** Immediate-capture settles at Peach when the shopper pays. Pre-auth (`PA`)
  capture and void use a separate Peach API this provider does not implement.

## License

MIT. See [`LICENSE`](LICENSE). An independent, community-maintained project with no affiliation to Peach
Payments. Use at your own risk and test thoroughly against your own Peach account before going live.
