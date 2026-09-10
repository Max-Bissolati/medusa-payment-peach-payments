# Independent adversarial verification: result-code mapping + overrides

You are an INDEPENDENT, ADVERSARIAL verifier. Another model extracted this Medusa v2
payment provider from a production store and claims the result-code mapping is hardened.
Do not trust it. Re-derive every result. Return GO or NO-GO.

System (1 para): Peach/OPPWA result codes (like 000.000.000, 000.400.101, 800.100.100)
are mapped to Medusa payment-session statuses. The claimed hardening: risk-flagged
"success" codes 000.400.101 and 000.400.102 deliberately map to error (fail closed), and
a merchant-supplied resultCodeOverrides option can remap codes but can NEVER affect the
refund success check.

SINGLE CONCERN: src/providers/peach/lib/result-codes.ts, its call sites in
src/providers/peach/service.ts and the refund success check in
src/providers/peach/lib/peach-client.ts, and the result-code tests.

Required checks:
1. Bucket regexes: for each pattern, hunt for codes that land in the wrong bucket
   (prefix/suffix junk, whitespace, case, unicode digits, similar-looking families).
   Success must be impossible for any code not in Peach's success families.
2. 000.400.101 and 000.400.102 map to error at EVERY call site (authorize, getPaymentStatus,
   webhook body action, webhook /status re-confirmation).
3. resultCodeOverrides: applied before the buckets at the intended call sites; verify it is
   NOT consulted by the refund success path (trace the actual call chain, do not trust
   comments); malformed override values are rejected at options-validation time.
4. Fail-closed defaults: empty/null/undefined/unknown codes never map to a success status.
5. Tests pin all of the above.

OUT of scope (do NOT report as findings): amount comparison internals, HMAC, OAuth,
packaging, docs, examples/. The warn-once console warning UX is not a finding.

Verdict rules: NO-GO for any confirmed path where a non-success code reaches
authorized/captured (other than via an explicit merchant override, which is by design and
warned), or where an override influences refund success. LOW hardening notes do not block.

Output template (end with exactly one verdict line):
FINDINGS: numbered list (severity, file:line, claim, evidence)
SOLID: what you verified holds
VERDICT: GO | NO-GO — CONFIRMED CRITICAL: n, HIGH: n, MEDIUM: n, LOW: n
