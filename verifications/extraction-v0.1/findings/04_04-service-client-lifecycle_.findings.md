# Independent adversarial verification: provider lifecycle + HTTP client

Scope: `src/providers/peach/service.ts` (lifecycle) and
`src/providers/peach/lib/peach-client.ts` (OAuth, createCheckout, getStatus,
refund), plus their tests. Baseline: `service.unit.spec` + `peach-client.unit.spec`
+ `peach-client-status.unit.spec` = 57/57 pass. Framework version verified
`@medusajs/payment@2.13.1`.

Method: re-derived every required check from source, verified the Medusa v2
framework trust invariant against the installed module, ran the suite, and
probed the refund signature coverage empirically (signature covers exactly the
sent body keys; any field tamper changes the signature).

## FINDINGS

1. LOW — `peach-client.ts:80-110` (`getToken`). No mutex around the cache
   check + refresh. Two concurrent calls that both observe an expired cache
   each fire an OAuth POST (double-fetch). Not unsafe — both fetched tokens
   are valid, the last writer wins in `tokenCache`, and no call can return an
   expired token (the `now < expiresAt` guard runs before every return, with a
   60s buffer / 30s floor). Pure efficiency / rate-budget note.

2. LOW — `service.ts:270-275` (`refundPayment` return). `lastRefund.result`
   stores the full Peach V1 refund JSON into payment session data. The V1
   refund response is transaction-level (result.code/description, id,
   paymentType, amount, currency) and carries no card PAN or credential, so
   this is not a secret leak; it is, however, slightly broader data retention
   than the `retrievePayment` whitelist policy (service.ts:294-303) deliberately
   enforces elsewhere. Cosmetic inconsistency, no exposure.

3. LOW — `peach-client.ts:99-101` (OAuth failure message). The thrown error
   stringifies the OAuth response body. The throw fires only when
   `!res.ok || !json.access_token`, i.e. precisely when no token is present,
   so no bearer token can appear in the message. Could echo gateway
   diagnostics on a malformed response. Informational only.

No CRITICAL, HIGH, or MEDIUM findings.

## SOLID (verified to hold)

### Trust boundaries (concern 1)
- `initiatePayment` (service.ts:133-169): `amount` from `input.amount`,
  `currency` from `input.currency_code` (both server-supplied by the payment
  module), minted `merchantTransactionId` server-side. Only `input.data.*`
  pass-throughs are `session_id`, `defaultPaymentMethod`, `forceDefaultMethod`,
  `createRegistration`, `cartId`, `requiresShipping` — all UI hints, none
  money-bearing. Checkout is amount- and currency-locked at Peach on creation.
- `authorizePayment` (service.ts:172-210): the money-safety invariant rests on
  `input.data.amount` being provider-derived, not storefront-writable. VERIFIED
  against the installed framework: `payment-module.js:137` writes session data
  as `{ ...input.data, ...providerPaymentSession.data }` (provider LAST), and
  `payment-module.js:210-213` passes `data: session.data` (the stored
  provider-derived blob) into `authorizePayment`. So `input.data.amount` ==
  the value `initiatePayment` wrote. The amount-integrity gate then
  re-confirms against Peach's authoritative `/status` amount
  (`amountsMatch`, fail-closed to `error` on mismatch OR missing Peach amount;
  pinned by service.unit.spec:156-181). A success `result.code` alone never
  completes.
- `getPaymentStatus` (service.ts:212-234): re-derives status from `/status`
  every call; maps via the fail-closed `mapResultCodeToStatus`. Informational
  only (does not move money); the authorize path carries the gate.
- `refundPayment` (service.ts:241-276): `transactionId` from
  `input.data.transactionId` (written by `authorizePayment`, not the
  storefront), `amount` from `input.amount` (server), `currency` from
  `input.data.currency` (written by `initiatePayment`). No client-tamperable
  value is trusted; refuses to substitute `checkoutId` for `transactionId`
  (service.ts:245-252, pinned service.unit.spec:303-313).
- `updatePayment` (service.ts:316-323): amount-locked check uses
  `input.data.amount` (provider-derived) vs the new server `input.amount`;
  re-mints a fresh checkout on any change.
- `getWebhookActionAndData` (service.ts:325-433): explicitly does NOT trust
  the replayable classic body — re-confirms action AND amount from `/status`
  keyed on `checkoutId`, fails closed when `/status` is unreachable or yields
  no authoritative amount (service.ts:394-421).

### Refund path (concern 2)
- Signature construction (`signV1`, peach-client.ts:360-369): sorted
  `key+value` concatenation with NO separator, HMAC-SHA256 over the
  `secretToken`. The sent body (`URLSearchParams({ ...signParams, signature })`,
  peach-client.ts:329) contains exactly `signParams` + `signature` — probed
  empirically: `sentKeys === [amount, authentication.entityId, currency, id,
  paymentType, signature]`, and altering any field changes the signature. So
  the signature binds the exact bytes Peach will decode. Pinned by
  peach-client.unit.spec:288-298.
- Decline handling (peach-client.ts:341-352): a non-2xx throws; then a 200
  with a non-success `result.code` ALSO throws via `isSuccessful`. So a
  Peach-style HTTP-200-declined refund can never be recorded as success.
  `service.refundPayment` wraps the throw in a staff-actionable `MedusaError`
  whose message states the refund "was NOT recorded" (service.ts:264-268,
  pinned service.unit.spec:315-328).
- Partial refunds: `formatPeachAmount(input.amount)` formats whatever is
  passed; partial amounts flow straight through (service.unit.spec:287-301
  records `lastRefund.amount`).
- Missing `secretToken`: hard throw before any network call
  (peach-client.ts:293-295, pinned spec:334-338). Missing/invalid currency:
  hard throw before any network call, including a malformed `defaultCurrency`
  (peach-client.ts:301-311, pinned spec:313-318, 328-332).

### OAuth cache (concern 3)
- 401 retry: `authedFetch` (peach-client.ts:386-411) retries EXACTLY once —
  default `retry=true`, on 401 it `clearToken()`s and re-enters with
  `retry=false`; a second 401 throws. No loop. Pinned spec:252-263.
- Expiry buffer: `expiresAt = now + max(ttl-60, 30)*1000`
  (peach-client.ts:104-108). 60s buffer, 30s floor. Pinned (refresh test,
  spec:67-81).
- Concurrent refresh: see FINDING #1 — double-fetch possible, never an
  expired token sent (every return is guarded by `now < expiresAt`), never an
  infinite loop.

### Error mapping (concern 4)
- `authorizePayment` catch → `{ status: "pending", data: input.data }`, never
  throws out of `cart.complete` (service.ts:205-209, pinned spec:199-205).
- `getPaymentStatus` catch → `{ status: "pending", ... }` (service.ts:228-233,
  pinned spec:209-215).
- `retrievePayment` catch → existing data unchanged (service.ts:304-309,
  pinned spec:252-257).
- Amount-gate failure → `{ status: "error", ... }` (fail closed), not
  captured/authorized (service.ts:197-202, pinned spec:156-181).
- No `undefined`/ok-shaped return path: every branch returns an explicit
  `{ status, data }` / `{ data }` object; missing `checkoutId` returns
  `error`/`pending` rather than throwing (service.ts:174-176, 214-216).
- A transient `/status` failure therefore maps to a safe non-success
  (pending), never to captured/authorized.

### Secrets (concern 5)
- `clientSecret` appears only in the OAuth POST body (peach-client.ts:92) and
  the missing-cred check (peach-client.ts:416). Never logged, never in
  session data, never in the browser field set.
- `secretToken` appears only in `signV1` (peach-client.ts:366) and
  `verifyPeachWebhook` (service.ts:340). Never logged, never in session data.
- Bearer token appears only in `Authorization` headers
  (peach-client.ts:334, 396). Never logged, never in session data.
- Browser-exposed field set (service.ts:155-167): `checkoutId, redirectUrl,
  entityId, merchantTransactionId, amount, currency, sdkUrl, mode`.
  `entityId` is documented semi-public (types.ts:29; required by the SDK).
  No secret in the set. Grep across `src/providers/peach` confirms no
  `clientSecret`/`secretToken`/`access_token`/`Bearer` value reaches
  `logger_*` calls, thrown messages, or the `data` return objects.
- OAuth failure message (peach-client.ts:99-101) stringifies the response
  body, but only on the `!res.ok || !json.access_token` branch — i.e. when
  there is no token to leak. Safe.

### Tests (concern 6)
- Amount-integrity gate: mismatch + missing-amount + pending-passthrough
  pinned (service.unit.spec:156-190).
- Refund: happy path, declined-throws, no-transactionId-throws,
  missing-secret-throws, currency default/uppercase/malformed pinned
  (service.unit.spec:286-329; peach-client.unit.spec:266-345).
- OAuth: cache reuse, expiry refresh, 401-retry-once, missing-creds pinned
  (peach-client.unit.spec:52-88, 239-264).
- Error mapping: getStatus-throws → pending for authorize/getStatus/retrieve
  pinned (service.unit.spec:199-215, 252-257).
- `retrievePayment` PII whitelist (no raw `card.*`/`threeDS` spread) pinned
  (service.unit.spec:225-258).
- The only gaps vs. the brief are test coverage for (a) concurrent OAuth
  double-fetch and (b) explicit secret-leak assertions on the data return —
  neither is exploitable (see SOLID above), so they are LOW omissions, not
  blockers.

## VERDICT: GO — CONFIRMED CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 3
