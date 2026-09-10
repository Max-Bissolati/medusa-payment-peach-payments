# Webhooks

This is the detail behind the Webhooks section in the README: how the URL is derived, what Peach
actually sends, and how the provider verifies it. None of this needs configuring by hand: it's
here so you can reason about the fail-closed behaviour rather than trust it blindly.

## URL derivation

Medusa's payment module auto-mounts one webhook route per registered provider, at
`{MEDUSA_BACKEND_URL}/hooks/payment/<provider_id>`, where `<provider_id>` is `pp_<identifier>_<id>`.
For this provider (`identifier: "peach"`) with `id: "peach"` in `medusa-config.ts`, that resolves to:

```
{MEDUSA_BACKEND_URL}/hooks/payment/pp_peach_peach
```

Register that exact path with Peach (Dashboard/Console webhook settings) and also set it as the
`notificationUrl` option so it's sent along with `POST /v2/checkout`. If you use a different `id`,
the path segment changes with it: `id: "checkout"` becomes `pp_peach_checkout`, and so on.

## What Peach sends

Peach's classic Checkout webhook (what Embedded and Hosted both fire, as distinct from the newer
Payment Links webhook format) is a POST with an `application/x-www-form-urlencoded` body. The
outcome is carried in a `result.code` field in that body, and the request is signed by putting a
`signature` field inside the same body, not in a header. The signed message is every other body
field (including empty ones), sorted alphabetically by key, concatenated as `key` then `value` with
no separator between them or between pairs, HMAC-SHA256'd with your `secretToken`, hex-encoded.

Peach's own reference for this is
[developer.peachpayments.com/docs/checkout-webhooks](https://developer.peachpayments.com/docs/checkout-webhooks).
(Peach also documents a newer header-based HMAC scheme, used by their Payment Links product.
This provider tries that as a fallback, but Checkout V2 webhooks use the body-signature scheme
described above.)

## Why the provider has two verification code paths

Medusa's built-in webhook route parses the incoming form-urlencoded body into a plain object
(`payload.data`) before handing it to the provider, and in doing so it drops the original raw
bytes. That's a problem for signature verification, which needs the exact bytes Peach sent (or an
exact reconstruction of them) to recompute the HMAC.

The provider handles both cases:

1. **Raw body preserved.** If `payload.rawData` is present, the provider parses it with
   `URLSearchParams`, pulls out the `signature` field, and verifies against the remaining sorted
   key-value pairs directly.
2. **Raw body absent (the common case with Medusa's default route).** The provider instead
   reconstructs the same signed message from `payload.data`: nested objects are flattened back to
   bracket notation (`customParameters: { medusaSessionId }` becomes
   `customParameters[medusaSessionId]`, matching how Peach names them in the original form body),
   the `signature` field is excluded, the remaining pairs are sorted and concatenated the same way,
   and the HMAC is recomputed and compared.

Either path fails closed: with no `secretToken` configured, or a signature that doesn't match,
verification returns invalid and the webhook is ignored (action `not_supported`) rather than
authorising or capturing anything. The primary completion path (authorize-on-return) does not
depend on the webhook at all, so an unverifiable or misconfigured webhook degrades to "the backup
path is unavailable," not "payments silently fail."

## What happens after verification

A verified webhook still isn't trusted at face value. The provider:

1. Reads the result code from the body and maps it through the same result-code table used
   everywhere else in the provider. If that doesn't map to `authorized` or `captured`, the
   provider does nothing (`not_supported`). Pending, declined, and cancelled webhooks are left for
   the authorize-on-return path or a later retry, since acting on a non-terminal state risks
   flapping an order's status.
2. For an apparent success, it re-fetches `GET /v2/checkout/{checkoutId}/status` and uses that
   response, not the webhook body, as the authoritative outcome and amount. This is deliberate defense in depth:
   the notification body is treated as a wake-up signal only, and the authoritative outcome and
   amount always come from a fresh server-to-server lookup. Nothing an intermediary could do to
   the notification body can change what the plugin records.
3. If `/status` doesn't agree that the payment succeeded, or returns no amount at all, the
   provider ignores the webhook rather than completing the order on partial information.

## Delivery semantics

Peach retries a webhook delivery on non-200 responses for up to 30 days, and does not guarantee
ordering: a late "pending" or "cancelled" notification can arrive after a success notification
for the same checkout. Because the provider only acts on a re-confirmed success and otherwise
returns `not_supported`, a late out-of-order notification can't downgrade an already-completed
order.
