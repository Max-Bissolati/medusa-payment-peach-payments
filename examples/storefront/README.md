# Storefront reference (Next.js / React)

This is reference code, not a dependency. Copy what you need into your own storefront and adjust
the imports, styling, and error handling to match. It was adapted from a real Next.js integration
against this provider, with store-specific naming and business logic scrubbed out.

## The flow

1. **Create a payment session.** Once the cart has an address and a shipping method, call
   `medusa.store.payment.initiatePaymentSession(cart, { provider_id: PEACH_PROVIDER_ID, data: {...} })`.
   This calls the provider's `initiatePayment`, which creates a Peach checkout and stores the
   browser-safe fields (`checkoutId`, `entityId`, `sdkUrl`, `amount`, ...) on the payment session's
   `data`. Re-retrieve the cart afterward and read the session back with `getPeachSessionData`,
   see `lib/peach.ts`.
2. **Mount the widget with `checkoutId` + `entityId`.** `checkout-payment.tsx` loads the Peach
   Checkout SDK script from the session's `sdkUrl` and calls `window.Checkout.initiate({ key:
   entityId, checkoutId, eventHandlers })`. `key` is the entity id, not a secret, but it is
   specific to your Peach account. Never hardcode it; always read it from the session.
3. **The shopper pays** inside the widget (card, EFT, BNPL, whatever your Peach account has
   enabled; the widget renders what's available).
4. **The shopper returns to `shopperResultUrl`.** The widget's `onCompleted` handler also
   navigates there directly for the embedded case, so hosted-redirect and embedded both converge
   on the same page. `peach-result/peach-result-content.tsx` is that page: it calls
   `cart.complete()`, and if that doesn't immediately resolve, it distinguishes a genuine decline
   from a still-pending payment from an already-settled one by reading the Peach payment session's
   `status` (`pickActivePeachSession` in `lib/peach.ts`) and by checking whether the cart already
   has a `completed_at` (meaning an order exists, most likely because the webhook beat the
   redirect).
5. **`cart.complete()` authorizes the session**, which is where the provider's `authorizePayment`
   polls Peach's `/status` endpoint and applies the amount-integrity check described in the main
   README. A success here creates the order.
6. **The webhook is the source of truth for anything that misses this page:** a closed tab, a
   slow 3DS challenge, a network blip on the redirect. It runs entirely on the backend (see the
   main README's Webhooks section); the storefront doesn't need to know it exists, other than that
   `cart.complete()` on a later visit (or the background poll in `peach-result-content.tsx`) will
   pick up an order the webhook already created.

## Files

- `lib/peach.ts`: the provider id constant, session data types, `pickActivePeachSession` (handles
  Medusa v2's session accumulation so you don't read a stale amount-locked session), and a couple
  of amount-comparison helpers for keeping the displayed total in sync with the locked checkout
  amount.
- `checkout-payment.tsx`: the embedded widget. Script loading, mount/unmount lifecycle tied to
  `checkoutId` (which is single-use), and the event handlers for completion, cancellation, error,
  and the 30-minute expiry.
- `peach-result/page.tsx` and `peach-result/peach-result-content.tsx`: the authorize-on-return
  handler described above, including the polling and decline/pending/settled discrimination logic.

## What was left out

An Apple Pay / Google Pay (Embedded Express) example was considered but skipped. The source
version is written against store-specific shipping-size logic, hardcoded province lists, and a
geolocation-based address autofill, none of which adapts cleanly into a generic example without
either misrepresenting it as more general than it is or stripping so much that it stops being
useful as a reference. If you're building Embedded Express, start from
[developer.peachpayments.com](https://developer.peachpayments.com)'s Embedded Express docs and the
provider's `PeachStatusShipping`/`PeachStatusCustomer` types (`src/providers/peach/types.ts`) for
the wallet-collected address shape; `examples/embedded-express/` in this repo has a smaller,
already-generic recipe for mapping that address onto a Medusa cart.
