# Independent adversarial verification: webhook HMAC + webhook action flow

You are an INDEPENDENT, ADVERSARIAL verifier. Another model extracted this Medusa v2
payment provider and claims its webhook path is hardened. Do not trust it. Re-derive
every result. Return GO or NO-GO.

System (1 para): Medusa auto-mounts a webhook endpoint that calls the provider's
getWebhookActionAndData with the (already body-parsed) payload. The provider verifies a
Peach HMAC signature (raw-body path AND a parsed-body reconstruction path, because Medusa
drops the raw bytes for urlencoded posts), then, instead of trusting the notification
payload, re-confirms the outcome AND the amount server-to-server via Peach's /status API.

SINGLE CONCERN: src/providers/peach/lib/verify-webhook.ts, getWebhookActionAndData in
src/providers/peach/service.ts, and their tests.

Required checks:
1. Signature verification: timing-safe comparison everywhere, length-mismatch handling,
   missing/empty/array-valued signature inputs rejected, no verification path that
   defaults to accepted when the secret or signature is absent.
2. Parsed-body reconstruction: can an attacker craft a parsed body whose reconstruction
   collides with a differently-signed original (key order, repeated keys, nested keys,
   bracket flattening, + vs %20, unicode)? Any acceptance without a valid signature is
   critical.
3. Forged/replayed webhook: with a validly-signed but stale or tampered body, confirm
   completion is driven by the /status response (outcome and amount), never by body
   fields. Find any body field that leaks into the emitted action/data unverified.
4. Failure behavior: unverifiable signature, missing checkoutId, /status error, or
   /status without an amount must never emit a success action.
5. Tests pin all of the above.

OUT of scope (do NOT report as findings): amount comparison internals (separate run),
result-code bucket regexes (separate run), OAuth, packaging, docs, examples/. Webhook
idempotency/dedup is Medusa's responsibility above the provider, not in scope.

Verdict rules: NO-GO for any confirmed signature bypass, or any path where an unverified
or unconfirmed webhook can emit a success/captured action. LOW hardening notes do not block.

Output template (end with exactly one verdict line):
FINDINGS: numbered list (severity, file:line, claim, evidence)
SOLID: what you verified holds
VERDICT: GO | NO-GO — CONFIRMED CRITICAL: n, HIGH: n, MEDIUM: n, LOW: n
