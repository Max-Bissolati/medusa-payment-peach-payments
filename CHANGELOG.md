# Changelog

## 2026-09-10 (v0.1.1)

Docs only, no code changes. Generalized the provenance and origin wording in the README and the
extraction verification notes: the verification findings are retained in full, with the specific
tools, models, and systems used to run them removed. Published package behaviour is unchanged.

## 2026-07-07 (v0.1.0 published)

First public release. Repo live at github.com/Max-Bissolati/medusa-payment-peach-payments,
package published to npm as medusa-payment-peach-payments@0.1.0 through the release
workflow with provenance, after a green CI run on Node 20 and 22. A pre-publish leak audit
(one adversarial reviewer over the working tree, full git history, and the extracted
tarball including decoded sourcemaps, plus a second independent review) found no
credentials, internal references, or private names; the repo history was squashed to a
single clean commit before the first push. One operational note: the first CI runs crawled
because the hosted runner's route to the npm CDN was degraded (46 to 86 seconds per large
tarball); nothing in the repo was at fault and the run passed once left to finish.

## 2026-07-07 (verification loop closed: sandbox E2E, independent review, CI fix)

The adversarial verification loop completed. The full record lives in
verifications/extraction-v0.1/FINDINGS_LOG.md; the short version:

- **Sandbox end to end: pass.** The packed tarball, installed into a scratch Medusa app
  (Medusa 2.17.2, Docker Postgres), drove a real Peach sandbox checkout: OAuth +
  /v2/checkouts, hosted-page card payment with a test Visa, cart completion through the
  /status re-confirmation and amount-integrity gate (order created, 100.00 ZAR captured,
  result code 000.100.110), and a full V1 HMAC refund accepted by Peach. No plugin bugs.
  Caveat: the sandbox entity runs in Integrator Test Mode, so the 3DS challenge path was
  not exercised.
- **Independent review (five single-concern briefs): GO** on amount/currency,
  result codes, webhook HMAC, and lifecycle/client (zero critical/high/medium, each
  confirmed by two runs). The packaging review found one real bug and one gap, both fixed:
- **CI leak assertions were inert (high).** The negated grep checks in test.yml could
  never fail the job because bash's `set -e` ignores `!`-inverted commands. A src/ or
  examples/ leak in the publish artifact would have passed CI silently. Rewritten as
  positive-logic ifs; release.yml now runs the same artifact assertions before publish.
- **Exports map advertised unreachable subpaths (medium).** The `./*` catch-all pointed
  directory modules (like the admin bundle) at flat files that do not exist. Added an
  explicit `./admin` export; the documented `providers/peach` path was always correct.
- Also: two stale JSDoc comments said the webhook path was `peach_<id>`; it is
  `pp_peach_<id>`. Remaining LOW notes from the reviewers are recorded in BACKLOG.md as
  non-blocking polish.

## 2026-07-07 (red-team round: hardening, lockfile, shipped types)

A red-team pass over the extracted plugin confirmed eight findings. All fixed at the root, each
with regression tests where applicable. Suite grew from 130 to 182 tests, all green.

- **Lockfile broke `npm ci` on Node 22 (high).** The committed lockfile tripped npm's
  optional-peer bug around `fdir@6.1.1` / `picomatch` ("Invalid: lock file's picomatch@2.3.2 does
  not satisfy picomatch@3.0.2"). Regenerated `package-lock.json` with npm 11.18.0 and verified a
  fresh `npm ci` under npm 10.9.8 (Node 22), npm 11.13 (Node 24), and npm 11.18. The test
  workflow now runs a Node 20/22 matrix so this class of break is caught in CI, and `.nvmrc`
  pins 20 for local work.
- **No TypeScript declarations shipped (medium).** The tarball had zero `.d.ts` and the exports
  map had no `types` condition, so TS consumers hit TS7016. The build now runs a
  declaration-only `tsc` pass (`tsconfig.declarations.json`) after `medusa plugin:build`, the
  exports map carries `types` conditions, and the public types (`PeachOptions` and friends) are
  re-exported from the provider index. Verified with a strict-TS scratch project compiling
  against the packed tarball. `prepublishOnly` now runs the full build so a publish can't ship
  without types.
- **Refund currency not normalized (low).** `resolveCurrency()` now uppercases at the single
  root and rejects anything that isn't a 3-letter ISO code, before any network call, in both the
  initiate and refund paths. `PeachClient.refund` also uppercases and validates, since the
  currency is part of the signed V1 message.
- **`amountsMatch(" ", "0.00")` returned true (low).** `Number(" ")` is 0. String inputs are now
  trimmed before the empty check on both sides, so whitespace-only amounts fail closed.
- **Result-code regex hardening (low).** Codes containing any whitespace are rejected before
  matching, buckets match the full `ddd.ddd.ddd` token instead of a prefix (so
  "000.000.000extra" is no longer success), and the `000.400.0x` class is digits-only. A
  table-driven test snapshots the pre-hardening mapping for every real code and asserts it is
  unchanged; only junk inputs moved (all to `error`).
- **Malformed `resultCodeOverrides` values passed through (low).** `validateOptions` now rejects
  any override value that isn't a legal Medusa payment session status, at boot, naming the
  offending key and value. Credential validation stays permissive as before.
- **Repo hygiene.** Deleted the stale `medusa-payment-peach-payments-0.1.0.tgz` at the repo root.
- **Docs.** README limitations now note the ~9e13 minor-unit float-precision bound, the options
  reference points at the exported `PeachOptions` type instead of an unshipped source path, and
  a new note explains that a bare `require("medusa-payment-peach-payments")` is not exported by design.
  `authorizePayment` gained a comment recording why `session.data.amount` is trustworthy
  (Medusa spreads provider-returned session data last; verified against @medusajs/payment 2.13.x).

Final gate: fresh `npm ci`, typecheck, 182 tests, `npm run build`, and an `npm pack` whose
tarball contains the compiled `.js` plus `.d.ts`, no `src/`, no `examples/`, no specs, and zero
hits on the private-name leak grep.

## 2026-07-07 (docs + examples)

Replaced the stub README with the real one: what the provider is (and isn't, unaffiliated,
unofficial), requirements, install, a fully-commented registration snippet covering every
`PeachOptions` key, an env-var naming table, the completion model, webhook setup (URL derivation,
why no body-parser config is needed), refunds, sandbox testing with public test-card numbers, a
factual hardening section, and the limitations (two-decimal currencies only, no ZAR default, no
cancel endpoint). Split the webhook signature/verification detail into `docs/WEBHOOKS.md` so the
README stays scannable.

Added `examples/storefront/`: a Next.js/React reference adapted from a real storefront integration
covering the full flow: reading the active session off the cart (`lib/peach.ts`), mounting the
embedded widget (`checkout-payment.tsx`), and the authorize-on-return handler
(`peach-result/`). All store-specific naming, domains, and business logic (shipping-size
tiers, hardcoded provinces, geolocation autofill) were scrubbed or, where they didn't adapt
cleanly, left out. The Embedded Express (Apple/Google Pay) example was skipped for that reason,
and the omission is explained in `examples/storefront/README.md`. Test-card numbers and the
webhook/embedded-SDK links were sourced fresh from developer.peachpayments.com, not carried over
from the private integration this was extracted from.

No source changes. Read `src/` for accuracy while writing but found nothing worth flagging.

## 2026-07-07

Initial extraction. The provider was generalized from a production Medusa v2 Peach Payments (Checkout V2) integration: checkout creation, authorize-on-return with an amount-integrity gate, verified webhooks that re-confirm outcome and amount against GET /status (fail closed), and V1 HMAC refunds that treat a declined-but-HTTP-200 refund as a failure.

Generalized for public use:

- No hardcoded currency or country. `defaultCurrency` and `defaultCountryCode` options replace the ZAR/ZA literals; with no session currency and no default the provider throws a clear error, and the billing country is omitted entirely when unknown.
- `resultCodeOverrides` option: a per-code map checked before the built-in result-code buckets. Overriding a fail-closed decline/error to a success status logs a warning once per code. Without overrides the mapping is identical to the production behaviour.
- Refund error messages are currency-neutral.

Scrubbed on the way out: host-project names and URLs (replaced with example.com fixtures), store-specific references (replaced with neutral wording), and realistic fixture data (replaced with obviously fake names, phone numbers and ids). The store-specific shipping-validation hook was left behind; the Embedded Express wallet-address helper and route moved to examples/embedded-express as an uncompiled recipe.

All money-safety hardening carried over unchanged: the amount-integrity gate in authorizePayment, the webhook /status re-confirmation with no body-amount fallback, and every fail-closed path.
