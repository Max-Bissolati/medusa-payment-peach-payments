# CI workflows + README consistency — independent adversarial verification

Verifier: independent review. Date: 2026-07-07.
Scope: `.github/workflows/test.yml`, `.github/workflows/release.yml`, README install/registration
vs `package.json` exports and `src/providers/peach/types.ts`. Business logic, test content, and
examples/ are out of scope.

## FINDINGS

1. **HIGH — `.github/workflows/test.yml:32`** — The src/examples-leak assertion is a negated
   grep that can never fail the job, because GitHub Actions' default shell (`bash -eo pipefail`)
   does not let `set -e` abort on a `!`-inverted command, and this line is not the last command
   of the script.
   - **Claim under review:** "no swallowed exit codes … every step fails the job on failure."
   - **Evidence (empirical, reproduced GHA shell `bash -eo pipefail`):**
     - `CASE good            exit=0` (correct pass)
     - `CASE src-leak-only   exit=0` ← **BUG: a `src/` file in the tarball does NOT fail the job**
     - `CASE spec-leak-only  exit=1` (correct fail; only works because it is the *last* line)
     - `CASE both-leak       exit=1` (correct fail, by way of the spec line)
     - `CASE missing-dts     exit=1` (correct fail; positive grep under `set -e`)
   - **Mechanism:** bash `set -e` explicitly ignores a command "whose return value is being
     inverted with `!`" (bash manual). So `! grep … src|examples` returning 1 (leak detected)
     does not abort. The script's exit status is that of the *last* command (`! grep … .spec`).
     If that last grep finds nothing (no spec leak), the script exits 0 even when a src/examples
     leak is present. Re-ordering the two negated greps would make *both* inert.
   - **Why HIGH not CRITICAL:** today no wrong artifact can ship, because `package.json`
     `"files": [".medusa/server"]` independently excludes `src/` and `examples/` from the
     tarball regardless of the grep. The grep is defense-in-depth and that defense is currently
     inert for one of its two checks. The harm is latent: it bites the day `files` regresses or a
     spec file is the only leak-absent path. Fix: append `|| { echo "leak"; exit 1; }` to each
     negated grep, or `set -o pipefail; grep … && exit 1 || true`, or a single `! grep -E … ||
     exit 1`.

2. **LOW — `src/providers/peach/service.ts:48` and `src/providers/peach/types.ts:35`** — Stale
   JSDoc comments say the webhook path is `/hooks/payment/peach_<id>` (missing the `pp_` prefix),
   while the authoritative comment at `service.ts:40` and the README (`pp_peach_<id>`) are
   correct. This is a comment-only inconsistency; the runtime identifier is `static identifier =
   "peach"` (`service.ts:54`), so the real provider id is `pp_peach_peach`, matching the README.
   Out of the brief's scope (prose/comment, not CI/README behavior) but noted for completeness.

3. **LOW — `.github/workflows/release.yml`** — Does not re-run the tarball-content assertions
     from `test.yml`; it relies on `prepublishOnly` (build) + the static `files` field. Not a
     defect (build is fresh, `files` is correct), just a polish observation.

## SOLID (verified to hold)

- **test.yml steps fail correctly except finding #1.** `npm ci`, `npm run typecheck`, `npm test`,
  `npm run build` are each single non-piped commands with no `continue-on-error`; each fails the
  job on non-zero exit. `npm pack --dry-run 2>&1 | tee pack.txt` correctly fails under
  `pipefail` if `npm pack` fails, and `2>&1` captures npm's stderr notices into `pack.txt`.
  Positive greps (`grep -q … index.js`, `…index.d.ts`) correctly fail under `set -e` when the
  built file is absent. Verified the built files exist (`.medusa/server/src/providers/peach/index.{js,d.ts}`).
- **grep patterns match npm pack's output format.** `npm notice <size><unit>  <path>` with units
  `B`/`kB`/`MB` is matched by `[0-9.]+[kMB ]+`; positive substring greps for the two built files
  match real output. The regex logic is sound; only the exit-code propagation is broken (finding #1).
- **release.yml cannot publish a wrong/stale artifact.** `npm publish` runs `prepublishOnly`
  (`package.json` script = `npm run build`) before packing, so the build is fresh, not stale.
  `files: [".medusa/server"]` limits the tarball to built output. Tag/version check strips the
  leading `v` and compares against `package.json` `version` exactly; it works for prerelease tags
  (e.g. `v1.2.3-beta.1` → `1.2.3-beta.1`) as long as the versions match character-for-character.
- **release.yml secrets and permissions are safe and minimal.** `NODE_AUTH_TOKEN` is sourced from
  `secrets.NPM_TOKEN` into env and never echoed; the tag-check echoes only version strings.
  `permissions: contents: read, id-token: write` (provenance) is minimal; no broad `contents: write`.
- **README registration `resolve` path resolves.** `medusa-payment-peach-payments/providers/peach` maps via
  `package.json` `exports["./providers/*"]` → `.medusa/server/src/providers/peach/index.{d.ts,js}`.
- **Every option key in the README snippet exists in `PeachOptions`.** mode, clientId,
  clientSecret, merchantId, entityId, secretToken, referer, notificationUrl, shopperResultUrl,
  cancelUrl, paymentType, merchantName, defaultCurrency, defaultCountryCode, resultCodeOverrides
  — all 15 keys are present in `src/providers/peach/types.ts:20-63`.
- **README env-var table is consistent with the snippet.** All 14 documented env vars map 1:1 to
  the option keys used in the snippet; `resultCodeOverrides` correctly has no env var (noted).
- **README webhook URL derivation matches the identifier.** `pp_peach_<id>` (→ `pp_peach_peach`
  with `id: "peach"`) matches `service.ts:54` `static identifier = "peach"` and the Medusa
  payment-provider id convention.

## VERDICT: NO-GO — CONFIRMED CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 2
