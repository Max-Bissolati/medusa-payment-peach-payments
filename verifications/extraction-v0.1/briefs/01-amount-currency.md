# Independent adversarial verification: amount integrity + currency handling

You are an INDEPENDENT, ADVERSARIAL verifier. Another model extracted this Medusa v2
payment provider from a production store and claims it is done and hardened. Do not
trust it. Re-derive every result from the code in front of you. Return GO or NO-GO.

System (1 para): medusa-payment-peach-payments is a standalone MedusaJS v2 payment provider for
Peach Payments (Checkout V2). Amounts are handled in major units at 2 decimal places
(ZAR-style). The provider claims an amount-integrity gate: authorization cross-checks
the amount Peach reports (via a server-to-server /status call) against the amount stored
in the payment session, failing closed on any mismatch or malformed value.

SINGLE CONCERN for this run: amount formatting/comparison and currency resolution ONLY.
Files: src/providers/peach/lib/amount.ts, the resolveCurrency/initiate/refund currency
logic in src/providers/peach/service.ts and src/providers/peach/lib/peach-client.ts
(currency parts only), and their tests in src/providers/peach/__tests__/.

Required checks:
1. formatPeachAmount and amountsMatch: enumerate malformed-input classes (null, undefined,
   "", whitespace strings, NaN, Infinity, negative, numeric strings with junk, objects,
   BigNumber-like inputs) and verify each fails closed (never a false match). Cite the
   line that handles or misses each class.
2. Float safety at realistic magnitudes (up to 9 digits of major units): can two different
   amounts compare equal, or one amount format to a different value?
3. Currency resolution: initiate and refund must both produce an uppercase 3-letter code
   or throw before any network call. Verify the validation is on the resolved value
   (option fallback included), not just the input.
4. Confirm the tests actually pin these behaviors (a regression exists per guarantee).

OUT of scope (do NOT report as findings): result-code mapping, webhook signatures, OAuth,
packaging, docs, anything in examples/. Zero-decimal and 3-decimal currencies are a
documented non-goal. validateOptions being permissive about missing credentials is by
design.

Verdict rules: NO-GO for any confirmed way a mismatched or malformed amount can authorize,
or a malformed currency can reach the network. LOW hardening notes do not block.

Output template (end with exactly one verdict line):
FINDINGS: numbered list (severity, file:line, claim, evidence)
SOLID: what you verified holds
VERDICT: GO | NO-GO — CONFIRMED CRITICAL: n, HIGH: n, MEDIUM: n, LOW: n
