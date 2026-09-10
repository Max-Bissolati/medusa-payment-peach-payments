# Independent adversarial verification — CI workflows + README consistency

Round: 2 (extraction-v0.1) · Verifier: independent review · Date: 2026-07-07
Scope: `.github/workflows/test.yml`, `.github/workflows/release.yml`, README install/registration
vs. `package.json` exports and `src/providers/peach/types.ts`.

All claims below were re-derived independently and, where load-bearing, exercised against the
real `npm pack --dry-run` output produced from the checked-out tree.

## Runtime / shell model (decisive for all exit-code reasoning)

Neither workflow sets an explicit `shell:` directive (`grep "shell:"` → no matches). On
`ubuntu-latest` runners GitHub Actions therefore uses its documented default
`bash --noprofile --norc -eo pipefail {0}`. Consequence: **both `set -e` (errexit) and
`set -o pipefail` are active** for every `run:` step. This is the assumption the whole
"verify publish artifact" step rests on; it is the correct assumption for these runners.

## test.yml — verify publish artifact (lines 25–41)

The step mixes one pipe (`npm pack --dry-run 2>&1 | tee pack.txt`), two positive greps, and two
negated-grep assertions written as positive-logic `if grep …; then exit 1; fi`. I exercised the
exact step body under `set -e; set -o pipefail` against the real clean output and four adversarial
mutations:

| Scenario | Input | Expected | Observed |
|---|---|---|---|
| A clean | real pack.txt | pass (rc=0) | `VERIFY_OK`, rc=0 ✓ |
| B src/ leak | + `npm notice 1.0kB src/providers/peach/leak.js` | rc=1 | "publish artifact leaks src/ or examples/", rc=1 ✓ |
| C examples/ leak | + `npm notice 1.0kB examples/storefront/foo.js` | rc=1 | "publish artifact leaks src/ or examples/", rc=1 ✓ |
| D spec leak | + `npm notice 1.0kB .medusa/.../service.spec.js` | rc=1 | "publish artifact leaks spec files", rc=1 ✓ |
| E missing index.d.ts | pack.txt with the `.d.ts` line removed | rc=1 (positive grep) | rc=1 ✓ |

Every assertion fails the job exactly when it should, and only then.

Exit-code reasoning, line by line:
- L27 `npm pack --dry-run 2>&1 | tee pack.txt` — under `pipefail`, a non-zero `npm pack` makes the
  whole pipeline non-zero, and `-e` aborts. The `tee` does **not** mask a pack failure. `2>&1`
  captures npm's notice lines (which npm writes to stderr). `tee pack.txt` truncates and rewrites
  pack.txt fresh each run, so no stale-file risk.
- L32–33 `grep -q "…index.js" / "…index.d.ts"` — bare statements, so `set -e` applies directly: a
  non-match (exit 1) aborts the job. These are the required positive assertions and they bite.
- L34–41 `if grep -E …; then exit 1; fi` — correct pattern. The author's comment (L30–31) is right
  that under `set -e` a `! grep` form is disarmed (errexit is suppressed for inverted commands and
  for `if` conditions), which is precisely why positive-logic `if` blocks are used here. When the
  leak matches, the body `exit 1`s; when it doesn't, control falls through. Sound.

Grep-pattern → real-output format fit (the brief asked this explicitly): `npm pack --dry-run` on
this tree emits `npm notice 1.0kB .medusa/server/src/providers/peach/index.js` — confirmed via
`cat -A` to be a **single space** between size and path (`461B .medusa…`, `1.0kB .medusa…`, `$`
EOL). The leak regex `^npm notice [0-9.]+[kMB ]+ (src|examples)/` matches the single-space form via
backtracking (`[kMB ]+` consumes `kB` + space, then the literal space in the pattern is satisfied on
re-match). Empirically proven against scenarios B and C above. The positive greps use `.` as a
regex wildcard that happens to coincide with the literal dots in the path — no false-negative, and
no unintended line in the real output triggers a false positive.

No `continue-on-error`, no `|| true` / `|| :`, no `always()` condition exists anywhere in the file
(`grep` over `.github/workflows` → no matches). Steps `checkout`, `setup-node`, `npm ci`,
`typecheck`, `test`, `build` all fail the job on non-zero by default. test.yml is correct.

## release.yml

- **Build-before-publish / stale artifact (the headline release risk).** Publish cannot ship a stale
  or unbuilt artifact. The `verify publish artifact` step (L34–47) runs `npm run build` then the
  same pack-content assertions as test.yml. The subsequent `npm publish` (L48) then triggers npm's
  `prepublishOnly` lifecycle hook, which `package.json:41` defines as `npm run build` — so the tree
  is rebuilt a second time immediately before the tarball is packed and uploaded. Even if a human
  deleted the verify-step build, `prepublishOnly` would still build. `--ignore-scripts` is not
  passed, so the hook is guaranteed to run. The published file set is exactly `package.json` `files`
  = `[".medusa/server"]`, the same set the verify greps inspect.
- **Tag-version check for prerelease tags (L26–33).** `TAG_VERSION="${GITHUB_REF_NAME#v}"`
  strips only the leading `v`, then string-compares to `require('./package.json').version`. Probed:
  tag `v0.1.0` vs version `0.1.0` → match (publish proceeds correctly); tag `v0.1.0-rc.1` vs
  `0.1.0` → mismatch → `exit 1`. So the check works for prerelease tags exactly as intended: a
  prerelease tag publishes only if `package.json` was bumped to the same prerelease string. It can
  never silently publish a version that doesn't match the tag. (Stray `v*` tags like `v-test` are
  rejected the same way — fail-safe.)
- **Secrets.** `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (L49–50) is the standard `setup-node`
  registry-token env pattern; it is never echoed. The only things the workflow echoes are
  `GITHUB_REF_NAME` and the package version, neither secret. No secret leakage path.
- **Permissions (L9–11).** `contents: read` (for checkout) + `id-token: write` (required for npm
  provenance / Sigstore OIDC). Nothing else. This is the documented minimal set for provenance
  publishing; `GITHUB_TOKEN` cannot do anything beyond read the repo. Minimal and correct.

release.yml is correct.

## README registration snippet (L34–116) vs. package.json exports + PeachOptions

- `resolve: "medusa-payment-peach-payments/providers/peach"` (L44). `package.json` exports map
  `"./providers/*"` → `.medusa/server/src/providers/*/index.{js,d.ts}`. Subpath `./providers/peach`
  therefore resolves to the built `index.js` / `index.d.ts`, both of which are present in the real
  tarball (`npm notice 1.0kB .medusa/server/src/providers/peach/index.js`,
  `461B …index.d.ts`). Resolves. ✓
- `import type { PeachOptions } from "medusa-payment-peach-payments/providers/peach"` (L126). `index.ts`
  re-exports `PeachOptions` (L17) from `./types`, and the `.d.ts` for that subpath ships. Resolves. ✓
- **Every option key in the snippet exists in `PeachOptions`** (`src/providers/peach/types.ts:20–63`):
  `mode, clientId, clientSecret, merchantId, entityId, secretToken, referer, notificationUrl,
  shopperResultUrl, cancelUrl, paymentType, merchantName, defaultCurrency, defaultCountryCode,
  resultCodeOverrides` — all 15 PeachOptions fields are documented in the snippet, and the snippet
  introduces no key that isn't in the type. The `paymentType` literal domain (`"DB" | "PA"`,
  types.ts:42) matches the README's `DB`/`PA` description. ✓
- **Webhook URL derivation.** README L118–121 states the provider id is `pp_<identifier>_<id>`, and
  with identifier `peach` + `id: "peach"` that is `pp_peach_peach`; L176–182 gives the webhook route
  `/hooks/payment/pp_peach_<id>` → concrete `/hooks/payment/pp_peach_peach`. Source confirms:
  `service.ts:54` `static identifier = "peach"` (asserted by
  `__tests__/service.unit.spec.ts:44–47`), and `index.ts:6` / `service.ts:40` / `types.ts:35` all
  document `pp_peach_<id>`. Identical derivation. ✓

## README env-var table (L138–153) vs. snippet

All 14 documented env→option mappings match the snippet one-for-one and use the identical option
names: `PEACH_MODE→mode, PEACH_CLIENT_ID→clientId, PEACH_CLIENT_SECRET→clientSecret,
PEACH_MERCHANT_ID→merchantId, PEACH_ENTITY_ID→entityId, PEACH_SECRET_TOKEN→secretToken,
PEACH_REFERER→referer, PEACH_NOTIFICATION_URL→notificationUrl, PEACH_SHOPPER_RESULT_URL→shopperResultUrl,
PEACH_CANCEL_URL→cancelUrl, PEACH_PAYMENT_TYPE→paymentType, PEACH_MERCHANT_NAME→merchantName,
PEACH_DEFAULT_CURRENCY→defaultCurrency, PEACH_DEFAULT_COUNTRY_CODE→defaultCountryCode`.
`resultCodeOverrides` is correctly excluded from the table (it's not a plain string; README L103–108
explains it must be set in code). Install command `npm install medusa-payment-peach-payments` (L26) matches
`package.json` `name`. ✓

---

## FINDINGS

1. **LOW** — `.github/workflows/test.yml:25-41` (whole file): the verify step's correctness depends
   on GHA's implicit default shell `bash -eo pipefail`. This is the documented, stable default on
   `ubuntu-latest` and is reliable, but neither workflow pins it with an explicit
   `shell: bash --noprofile --norc -eo pipefail {0}`. Not a defect today; would be a hardening
   improvement if the job ever ran on a self-hosted runner with a non-default `defaults.run.shell`.
   Evidence: `grep "shell:" .github/workflows/*` → no matches; GHA docs.

2. **LOW** — `.github/workflows/test.yml:34`, `release.yml:40`: the leak regex
   `^npm notice [0-9.]+[kMB ]+ (src|examples)/` is mildly coupled to npm's current size-unit + path
   format. It is **proven correct** against this npm version's single-space output (scenarios B and
   C above both exit 1), and is robust to padding because space is inside the class, but it relies
   on backtracking across the `[kMB ]+` boundary. If npm ever switched to tab separation it would
   silently stop matching. Not a blocker; informational.

No other findings. No CRITICAL, HIGH, or MEDIUM defects located.

## SOLID (independently verified to hold)

- test.yml fails the job on every real failure mode: non-zero npm/typecheck/test/build, missing
  index.js/index.d.ts, and any src/, examples/, or *.spec.{js,ts,d.ts} leak. Proven empirically across
  five scenarios (table above).
- `npm pack --dry-run` pipe does not swallow a pack failure (pipefail active); `tee` cannot mask it.
- Negated-grep assertions are correctly written as positive-logic `if` blocks to avoid `set -e`
  disarming them — the author's own comment is accurate.
- release.yml cannot publish a stale/unbuilt artifact: `npm publish` runs `prepublishOnly`→
  `npm run build` (`package.json:41`), and the verify step rebuilds + content-checks first.
- release.yml tag check rejects any tag whose stripped form ≠ `package.json` version, including
  prerelease tags unless the version was bumped to match; fail-safe for stray `v*` tags.
- secrets handled via standard `NODE_AUTH_TOKEN` env, never echoed; permissions minimal
  (`contents: read` + `id-token: write` for provenance).
- README `resolve`/import subpaths resolve to real exported subpaths in `package.json` and real
  shipped files; all 15 snippet option keys exist in `PeachOptions` with matching literal domains;
  webhook URL derivation (`pp_peach_<id>` → `pp_peach_peach`) matches `static identifier = "peach"`
  in service.ts; env-var table is 1:1 with the snippet.

## VERDICT: GO — CONFIRMED CRITICAL: 0, HIGH: 0
