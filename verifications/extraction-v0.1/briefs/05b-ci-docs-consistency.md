# Independent adversarial verification: CI workflows + README consistency

You are an INDEPENDENT, ADVERSARIAL verifier. Another model wrote this plugin's CI and
README and claims they are correct. Do not trust it. Re-derive every result. Return GO
or NO-GO.

System (1 para): medusa-payment-peach-payments is a Medusa v2 payment provider plugin. CI: a test
workflow (node 20/22 matrix: npm ci, typecheck, test, build, tarball-content assertions)
and a release workflow (on v* tags: checks tag matches package.json version, then npm
publish with provenance). The release path is intentionally inert until the owner
approves publishing.

SINGLE CONCERN: .github/workflows/test.yml, .github/workflows/release.yml, and whether
the README's install/registration instructions match reality (package.json exports and
src/providers/peach/types.ts option names). Nothing else.

Required checks:
1. test.yml: does every step fail the job on failure (no swallowed exit codes via pipes
   without pipefail, no continue-on-error)? Note: the "verify publish artifact" step uses
   `cmd | tee` and negated greps -- reason carefully about exit-code semantics per line
   under GitHub Actions' default shell (bash -e -o pipefail?). Verify the grep assertions
   actually match npm pack --dry-run output format.
2. release.yml: can it publish the wrong thing (missing build before publish? does
   prepublishOnly cover it?), does the tag-version check work for prerelease tags, are
   secrets handled safely (no echo), are permissions minimal?
3. README registration snippet: resolve path exactly matches an exported subpath; every
   option key in the snippet exists in PeachOptions (src/providers/peach/types.ts); the
   documented webhook URL derivation (pp_peach_<id>) matches the identifier in
   src/providers/peach/index.ts / service.ts.
4. README env-var table: names consistent with the snippet.

OUT of scope: business logic, tests' content, examples/ code, prose style, whether
publishing should happen (owner-gated by design).

Verdict rules: NO-GO only for CI that cannot fail when it should, a release flow that
publishes a wrong/stale artifact, or README instructions that would not work if followed.
LOW polish notes do not block.

Output template (end with exactly one verdict line):
FINDINGS: numbered list (severity, file:line, claim, evidence)
SOLID: what you verified holds
VERDICT: GO | NO-GO — CONFIRMED CRITICAL: n, HIGH: n, MEDIUM: n, LOW: n
