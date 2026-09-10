# medusa-payment-peach-payments

An unofficial [Peach Payments](https://peachpayments.com) (Checkout V2) payment provider for
[Medusa v2](https://medusajs.com). It generalizes a production-grade Medusa v2 Peach integration,
carrying over the parts worth keeping: checkout creation, authorize-on-return completion with an
amount-integrity check, webhook handling that re-confirms the outcome server-to-server before
trusting it, and V1 HMAC refunds.

This project is **not affiliated with, endorsed by, or supported by Peach Payments**. It is a
community plugin maintained independently. If you hit a Peach API question that isn't about this
plugin's code, go to [developer.peachpayments.com](https://developer.peachpayments.com) or Peach's
own support channels.

## Requirements

- Medusa v2, `@medusajs/framework` and `@medusajs/medusa` `^2.13.0` (peer dependencies, not
  bundled: install them yourself if your project doesn't already have them).
- Node.js 20 or newer.
- A Peach Payments merchant account with Checkout V2 access, and (for testing) a sandbox entity.
  Peach's sandbox is requested through your account manager or support; see
  [Sandbox](https://developer.peachpayments.com/docs/dashboard-sandbox).

## Install

```bash
npm install medusa-payment-peach-payments
```

## Registration

Payment providers in Medusa v2 are registered inside the Payment module's `providers` array, not
the top-level `plugins` array. Add this to `medusa-config.ts`:

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
              // "sandbox" or "production". Default "sandbox". Drives which Peach
              // hosts (OAuth, Checkout API, SDK script) the provider talks to.
              mode: process.env.PEACH_MODE,

              // OAuth credentials from the Peach Dashboard (Checkout API access).
              clientId: process.env.PEACH_CLIENT_ID,
              clientSecret: process.env.PEACH_CLIENT_SECRET, // secret
              merchantId: process.env.PEACH_MERCHANT_ID,

              // The Checkout entity id. Doubles as the `authentication.entityId`
              // sent to Peach and the `key` the storefront passes to the SDK's
              // Checkout.initiate() call, so it goes to the browser (not a secret,
              // but treat it as semi-public rather than committing it to source).
              entityId: process.env.PEACH_ENTITY_ID,

              // HMAC signing key used for webhook verification AND the V1 refund
              // endpoint. Refunds need this even if you never wire up webhooks.
              secretToken: process.env.PEACH_SECRET_TOKEN, // secret

              // The storefront origin Peach allowlists. Sent as the Origin/Referer
              // headers on checkout creation. Peach validates the domain, not an
              // IP. No trailing slash.
              referer: process.env.PEACH_REFERER,

              // Your webhook URL, registered with Peach (see Webhooks below).
              // Medusa derives the actual route from the provider id; this option
              // just tells Peach where to send its POST.
              notificationUrl: process.env.PEACH_NOTIFICATION_URL,

              // Where Peach returns the shopper after paying (embedded and hosted
              // both use this).
              shopperResultUrl: process.env.PEACH_SHOPPER_RESULT_URL,

              // Where Peach sends the shopper if they cancel a hosted-redirect
              // payment. Not used by the embedded widget.
              cancelUrl: process.env.PEACH_CANCEL_URL,

              // "DB" = capture immediately (the common case for physical goods).
              // "PA" = pre-authorise, capture later. Default "DB".
              paymentType: process.env.PEACH_PAYMENT_TYPE,

              // Display name shown in the Peach checkout UI.
              merchantName: process.env.PEACH_MERCHANT_NAME,

              // Fallback currency used only when a payment session or refund
              // carries none of its own. With no session currency and no default
              // set, the provider throws rather than guessing. Peach's business is
              // ZAR-centric, but this option does not default to ZAR: set it
              // explicitly for your store.
              defaultCurrency: process.env.PEACH_DEFAULT_CURRENCY,

              // Fallback billing country (ISO alpha-2, e.g. "ZA") used when a cart
              // address has none. Left unset, the country field is omitted
              // entirely rather than guessed.
              defaultCountryCode: process.env.PEACH_DEFAULT_COUNTRY_CODE,

              // Optional per-result-code overrides, checked before the built-in
              // mapping. Not a plain string, so there's no single env var for it:
              // set it directly in code if you need it, e.g.:
              // resultCodeOverrides: { "000.400.101": "authorized" }
              // Overriding a code the built-in map treats as a decline/error logs
              // a warning once, since it loosens a fail-closed default.
            },
          },
        ],
      },
    },
  ],
})
```

The runtime provider id Medusa registers is `pp_<identifier>_<id>`. With the identifier fixed at
`peach` and `id: "peach"` as above, that's `pp_peach_peach`. If you pick a different `id` (e.g.
`"checkout"`), the provider id changes to match (`pp_peach_checkout`). Whatever it resolves to is
the `provider_id` your storefront selects when creating a payment session, and it's also the
segment Medusa uses to build the webhook URL (see below). For the exact shape and defaults of
every option, read the JSDoc on the exported `PeachOptions` type:

```ts
import type { PeachOptions } from "medusa-payment-peach-payments/providers/peach"
```

Note that a bare `require("medusa-payment-peach-payments")` (or `import "medusa-payment-peach-payments"`) is not
exported, by design: there is no meaningful package root for a Medusa plugin. Always import the
provider subpath, `medusa-payment-peach-payments/providers/peach`, as shown in the registration snippet.

## Environment variables

None of these are required by Medusa itself, they're just the convention this README uses above.
Name them however fits your project.

| Env var | Option | Notes |
|---|---|---|
| `PEACH_MODE` | `mode` | `sandbox` or `production`, default `sandbox` |
| `PEACH_CLIENT_ID` | `clientId` | |
| `PEACH_CLIENT_SECRET` | `clientSecret` | secret |
| `PEACH_MERCHANT_ID` | `merchantId` | |
| `PEACH_ENTITY_ID` | `entityId` | sent to the browser, not a secret |
| `PEACH_SECRET_TOKEN` | `secretToken` | secret; webhook HMAC + refund HMAC |
| `PEACH_REFERER` | `referer` | your storefront origin, no trailing slash |
| `PEACH_NOTIFICATION_URL` | `notificationUrl` | your webhook URL, see below |
| `PEACH_SHOPPER_RESULT_URL` | `shopperResultUrl` | where the shopper returns to after paying |
| `PEACH_CANCEL_URL` | `cancelUrl` | hosted-redirect cancel target |
| `PEACH_PAYMENT_TYPE` | `paymentType` | `DB` or `PA`, default `DB` |
| `PEACH_MERCHANT_NAME` | `merchantName` | |
| `PEACH_DEFAULT_CURRENCY` | `defaultCurrency` | fallback only, no ZAR default baked in |
| `PEACH_DEFAULT_COUNTRY_CODE` | `defaultCountryCode` | fallback only |

## Completion model

There are two independent paths to completing a payment, and only one of them needs to work for
an order to go through:

- **Primary: authorize-on-return.** The shopper is redirected back to `shopperResultUrl` after
  paying. The storefront calls `cart.complete`, Medusa calls the provider's `authorizePayment`,
  which polls `GET /v2/checkout/{id}/status` and maps the result code to a Medusa payment status.
  A success creates the order right there.
- **Backup: the webhook.** Peach also POSTs to your registered webhook URL. Medusa's built-in
  webhook route calls the provider's `getWebhookActionAndData`, which verifies the signature,
  re-confirms the outcome and amount against `/status`, and only then tells Medusa to authorise
  or capture. This covers a shopper who closes the tab before the redirect completes.

Both paths converge on the same `/status` call as the source of truth for the outcome and the
amount, so neither one can complete an order on the strength of an unverified webhook body or a
client-reported success alone.

## Webhooks

No custom route is needed on your end. Medusa auto-mounts
`{MEDUSA_BACKEND_URL}/hooks/payment/pp_peach_<id>` for every registered payment provider and
routes incoming POSTs to the provider's `getWebhookActionAndData`. With the registration above
(`id: "peach"`), that's `pp_peach_peach`, so the URL to register with Peach is:

```
https://your-backend.example.com/hooks/payment/pp_peach_peach
```

Register that URL in the Peach Dashboard/Console as your checkout's webhook endpoint, and set the
same value as `notificationUrl` in the provider options so Peach knows to expect it. Peach then
surfaces a signing secret when you add the webhook: that becomes your `secretToken`.

You don't need to configure a body parser for this route. Medusa parses the incoming
`application/x-www-form-urlencoded` webhook body itself, and the provider handles both cases:
verifying the signature from the raw body when it's preserved, and reconstructing the same signed
message from Medusa's already-parsed body when it isn't. Either way, verification fails closed:
an unverifiable webhook is ignored, never trusted. See `docs/WEBHOOKS.md` for the signature scheme
and the full verification path. Peach's own reference is at
[developer.peachpayments.com/docs/checkout-webhooks](https://developer.peachpayments.com/docs/checkout-webhooks).

## Refunds

Refunds go through Peach's older V1 endpoint (`POST /v1/checkout/refund`), signed with the same
HMAC key as webhooks. That means `secretToken` is required for refunds even in a setup that never
receives a webhook. The refund body is sent as flat, form-encoded key-value pairs (not nested
JSON) with a V1 HMAC signature over the sorted keys. Peach's checkout API and its refund
endpoint are genuinely two different signing schemes, which is easy to trip over if you're
building this from scratch. Peach also returns HTTP 200 for a *declined* refund, so the provider
checks the result code itself and throws rather than reporting a declined refund as a success.

Refunds need the original payment's transaction id (not the `checkoutId`). The provider stores it
on the payment session's data after a successful authorization, and reads it back for the refund
call. If that id is missing (for example, a payment authorised before this provider recorded it),
`refundPayment` throws a clear error rather than guessing or silently no-oping.

## Testing in sandbox

Set `mode: "sandbox"` and use your sandbox entity's credentials. Peach's sandbox bypasses the
success screen and OTP/challenge prompts for known test cards, redirecting straight to
`shopperResultUrl`. A few of the published test cards (any future expiry date; CVV is 3 digits for
Visa/Mastercard, 4 for Amex):

| Scheme | Card number | Outcome |
|---|---|---|
| Visa | `4200000000000091` | frictionless success |
| Mastercard | `5200000000000007` | frictionless success |
| Amex | `374500262001008` | frictionless success |

The full list, including challenge-flow and decline scenarios, is in Peach's
[test and go-live reference](https://developer.peachpayments.com/docs/reference-test-and-go-live).

## Hardening

This provider does a few things beyond the minimum `AbstractPaymentProvider` contract, carried
over from running against live traffic:

- **Amount-integrity gate.** `authorizePayment` cross-checks the amount Peach reports on
  `/status` against the amount the session was created for, and fails closed (`error`) on any
  mismatch or a missing Peach amount. A result code alone is never enough to complete an order.
- **Webhook re-confirmation.** The webhook handler does not act on the notification payload's
  claimed outcome or amount. It re-fetches `/status` by `checkoutId` and uses that response as the
  only source of truth, as defense in depth: trusting only a fresh server-to-server status lookup makes the outcome independent of anything in the notification body.
- **Conservative result-code mapping.** `000.400.101` and `000.400.102` (3DS "not
  participating"/"not enrolled" codes) map to `error`, not success. They're intermediate,
  risk-adjacent codes rather than terminal successes, and Checkout V2's real successes land on a
  terminal `000.100.1*` code instead.
- **Refund success can't be loosened by `resultCodeOverrides`.** Overrides only affect the
  authorize/webhook status mapping; a refund is still validated against its own result code
  regardless of what overrides are configured elsewhere.

None of this is exotic. It's what you'd want from any payment integration, but it's worth being
explicit about, since it's the main reason to reach for a maintained provider instead of a quick
custom one.

## Storefront integration

This package is backend-only; there's no npm-installable storefront SDK because Peach's Checkout
widget itself has none (it's a script-tag global, not an npm package). `examples/storefront/`
has reference React/Next.js code adapted from a real integration: reading the session off the
cart, mounting the embedded widget, and handling the return redirect. See
`examples/storefront/README.md` for the full flow and what to adapt.

## Limitations

- **Two-decimal currencies only.** Amounts are formatted and compared at 2 decimal places
  (`amountsMatch` rounds to the cent; `formatPeachAmount` forces `.toFixed(2)`). Zero-decimal
  currencies (e.g. JPY) and three-decimal currencies are not supported. Amounts beyond roughly
  9e13 in minor units lose float precision and are out of scope: this provider targets 2-decimal
  currencies at realistic order magnitudes only.
- **No built-in ZAR default.** Peach's own business is ZAR-centric, but this provider does not
  assume ZAR anywhere. Set `defaultCurrency` yourself if you want a fallback.
- **No cancel endpoint.** Peach's V2 API has no way to cancel a checkout server-side;
  `cancelPayment` is a no-op and unpaid checkouts simply expire after 30 minutes.
- **Capture is a no-op for `DB`.** Immediate-capture payments settle at Peach when the shopper
  pays; there's nothing for `capturePayment` to do. Pre-auth (`PA`) capture/void uses a separate
  Peach API this provider does not implement. See Peach's docs on capture and reversal.

## License

MIT, see `LICENSE`. This is an independent, community-maintained project with no affiliation to
Peach Payments; use it at your own risk and test thoroughly against your own Peach account before
going live.
