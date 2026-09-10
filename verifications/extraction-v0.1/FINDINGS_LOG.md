# Findings log: extraction-v0.1 verification run

Cumulative record across all rounds of the adversarial verification loop for the
initial extraction of medusa-payment-peach-payments.

Scope of the run: build integrity, the unit suite, npm pack + install into a scratch
Medusa app (boot gate), money-critical logic (amount gate, result codes, webhook HMAC,
refunds), and a Peach sandbox checkout end to end.

## Status timeline

- 2026-07-07: extraction complete (130 tests green, build + pack verified, confidentiality
  greps clean). In-house red-team round 1: three parallel reviewers (extraction fidelity,
  money logic, packaging/runtime).
- 2026-07-07: round 1 complete. Boot gate PASS on Medusa 2.17.2 (built against 2.13.1,
  peer range ^2.13.0, so this doubled as the forward-compat test): provider registers as
  pp_peach_peach, webhook route auto-mounts and fails closed, tarball leak-grep clean.
  Money logic: 64 adversarial probes, zero critical/high; session-swap, webhook-replay,
  HMAC-bypass and override-refund attacks all defeated. Fidelity: semantically identical
  to production except one LOW (refund currency case). Fix batch dispatched.

- 2026-07-07: fix batch landed (commits d3b716b, f310c84, 25be8ad): all round-1 findings
  fixed with regression tests; suite grew 130 -> 182, all green. Orchestrator re-ran the
  suite independently at HEAD 25be8ad: 182/182.
- 2026-07-07: sandbox E2E through the PACKED plugin in a scratch Medusa app: GO on every
  gate. Real sandbox OAuth + POST /v2/checkouts (checkoutId redacted), hosted-page card
  payment (Visa test card, Integrator Test Mode), cart completion exercising the /status
  re-confirmation + amount gate against live sandbox data (order created, 100.00 ZAR,
  result code 000.100.110 -> captured), and a full V1 HMAC refund accepted by Peach
  (paymentType RF, code 000.100.110). Zero plugin bugs. Caveats: 3DS challenge path not
  exercised (sandbox entity auto-approves in Integrator Test Mode); shopperResultUrl
  domain allowlisting means return-redirect landed on an allowlisted external domain
  (completion driven via the store API instead). Evidence in the session scratchpad
  (sandbox-e2e/).
- 2026-07-07: independent verification fan-out over five single-concern briefs
  started (amount/currency, result codes, webhook HMAC, lifecycle/client, packaging).

- 2026-07-07: independent verification results. Briefs 01-04 (amount/currency,
  result codes, webhook HMAC, lifecycle/client): GO, zero critical/high/medium, confirmed
  by two independent runs each (the fan-out was killed twice by the host but completed
  those briefs both times; reports archived in findings/). Brief 05 (packaging) timed out and
  was split: 05a exports/build returned GO with 1 MEDIUM (the ./* catch-all advertising
  directory-module subpaths that cannot resolve; fixed with an explicit ./admin export)
  and 05b CI/docs returned NO-GO with 1 confirmed HIGH: the negated-grep tarball-leak
  assertions in test.yml were inert under bash set -e (a '!'-inverted command never
  aborts), so a src/ leak could not fail CI. Fixed with positive-logic ifs in test.yml,
  the same assertions added to release.yml before publish, plus two stale JSDoc webhook
  paths (peach_<id> -> pp_peach_<id>). Commit 55afee4. Full local gate re-run: 182/182
  tests, build, pack clean. 05b re-verification dispatched on the fixed HEAD.

## Findings (round 1)

| # | Severity | Finding | Source | Disposition |
|---|----------|---------|--------|-------------|
| 1 | HIGH | Committed lockfile fails `npm ci` on Node 22 (fdir optional peer picomatch@3 not recorded by older npm) | packaging red-team | FIX: regenerate lockfile, CI node matrix [20, 22], .nvmrc |
| 2 | MEDIUM | No .d.ts in the published tarball; exports map lacks a types condition (TS7016 for strict consumers); README points at unshipped src file | packaging red-team | FIX: declarations build pass + types export condition + README pointer, verified by strict-TS probe against the tarball |
| 3 | LOW | Refund path does not uppercase or validate the resolved currency (initiate does); `defaultCurrency: "zar"` would sign a lowercase currency into the V1 refund body | fidelity + money red-teams (independent) | FIX: normalize in resolveCurrency and client refund; validate /^[A-Z]{3}$/ both paths; regression tests |
| 4 | LOW | `amountsMatch(" ", "0.00")` returns true (Number(" ") === 0 bypasses the empty-string guard) | money red-team probe 01 | FIX: trim before empty check, both arguments; regression tests |
| 5 | LOW | Success regexes prefix-anchored only: "000.000.000extra" and "000.000.000\n" match success. Not attacker-reachable (codes come from Peach /status; webhook re-derives from /status) but hardened anyway | money red-team probe 02 | FIX: trim + reject embedded whitespace + end-anchor; table-driven regression snapshot proves real-code mapping unchanged |
| 6 | LOW | `000.400.0[^3]` class matches non-digits ("000.400.0X" -> captured) | money red-team probe 02 | FIX: tighten to [0-24-9]; covered by the same regression table |
| 7 | LOW | Malformed resultCodeOverrides values ("banana") pass through to Medusa verbatim; merchant-config-only, fail-safe on the money path | money red-team probe 02 | FIX: validateOptions rejects illegal status values at boot |
| 8 | LOW | Stale medusa-payment-peach-payments-0.1.0.tgz in repo root risks stale-artifact installs | packaging red-team | FIX: delete |
| 9 | LOW | Bare require("medusa-payment-peach-payments") throws ERR_PACKAGE_PATH_NOT_EXPORTED (subpath-only by design) | packaging red-team | DOCS: note the providers/peach import path |
| 10 | INFO | Amounts beyond ~9e13 minor units lose float precision in formatPeachAmount/amountsMatch | money red-team probe 01 | DOCS: documented as an explicit limitation (2-decimal, realistic magnitudes) |
| 11 | INFO | Design invariant: session.data.amount/checkoutId are trustworthy because Medusa spreads provider-returned data last (verified in @medusajs/payment 2.13.x); AuthorizePaymentInput carries no authoritative amount | money red-team | DOCS: one-line comment at the amount gate |

## Attack surfaces probed and found solid (round 1)

Amount-integrity gate fail-closed matrix (8/8 probes); session-swap/amount-swap structurally
impossible (provider data spread last, traced through @medusajs/payment and core-flows);
webhook replay and body tampering defeated by /status re-confirmation (amount taken from
/status, not the signed body); HMAC verification (timing-safe compare, length guard, encoding
variants, prototype-pollution keys, array headers, repeated keys); refund decline handling
(HTTP 200 + declined code throws; overrides cannot reach isSuccessful); OAuth token cache
(single retry on 401, no loop, expiry buffer honored); result-code fail-closed basics
(empty/null/unknown never succeed; chargeback family not success; cancel codes map to
canceled).

## Recurring themes

- Currency handling was normalized at one call site (initiate) but not the other (refund):
  normalize at the single root, not per call site.
- Guards written as exact equality ("" check) miss the coerced-equivalent class (whitespace
  strings): guard on the normalized value.
- Prefix-anchored regexes on gateway codes: anchor both ends and reject embedded whitespace
  when the input is a closed vocabulary.
