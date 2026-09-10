# Independent adversarial verification: provider lifecycle + HTTP client

You are an INDEPENDENT, ADVERSARIAL verifier. Another model extracted this Medusa v2
payment provider and claims the session lifecycle is production-hardened. Do not trust
it. Re-derive every result. Return GO or NO-GO.

System (1 para): The provider implements Medusa's AbstractPaymentProvider: initiate
(creates a Peach checkout, stores checkoutId/amount/currency in session data), authorize
(re-confirms via /status + amount-integrity gate), capture, refund (Peach classic V1
endpoint with HMAC-signed body), cancel, getPaymentStatus, plus an OAuth-token-cached
HTTP client. Several session-data fields are intentionally exposed to the browser:
checkoutId, redirectUrl, entityId, merchantTransactionId, amount, currency, sdkUrl, mode.

SINGLE CONCERN: src/providers/peach/service.ts (all lifecycle methods) and
src/providers/peach/lib/peach-client.ts (OAuth, createCheckout, getStatus, refund), and
their tests.

Required checks:
1. Trust boundaries: for each lifecycle method, which inputs come from the shopper-visible
   session data vs the server? Find any place a client-tamperable value (amount, currency,
   checkoutId, status fields) is trusted without server-side re-confirmation.
2. Refund path: signature construction over the exact sent body, decline handling (an
   HTTP 200 with a declined code must throw, never record success), partial refund amount
   handling, missing secretToken/currency behavior.
3. OAuth cache: stale-token 401 retry (exactly once, no infinite loop), expiry buffer,
   concurrent-call behavior (two calls racing a refresh: any way to send an expired token
   or double-fetch unsafely?).
4. Error mapping: transient Peach/API failures during authorize/status must map to a safe
   non-success state (pending), never to captured/authorized; no error path that returns
   undefined/ok-shaped data.
5. No secret (clientSecret, secretToken, bearer token) can leak into session data, logs at
   info level, thrown error messages, or the browser-exposed field set.
6. Tests pin the above.

OUT of scope (do NOT report as findings): amount.ts internals, result-code regexes,
verify-webhook.ts internals (separate runs), packaging, docs, examples/. validateOptions
being permissive about missing credentials is by design (fails loudly at call time).

Verdict rules: NO-GO for any confirmed trust-boundary break, refund-success-on-decline,
secret leak, or unsafe error mapping. LOW hardening notes do not block.

Output template (end with exactly one verdict line):
FINDINGS: numbered list (severity, file:line, claim, evidence)
SOLID: what you verified holds
VERDICT: GO | NO-GO — CONFIRMED CRITICAL: n, HIGH: n, MEDIUM: n, LOW: n
