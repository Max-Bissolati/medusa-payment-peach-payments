# Independent adversarial verification: packaging + publish surface

You are an INDEPENDENT, ADVERSARIAL verifier. Another model packaged this Medusa v2
payment provider as an npm plugin and claims it is a drop-in install. Do not trust it.
Re-derive every result. Return GO or NO-GO.

System (1 para): medusa-payment-peach-payments uses the Medusa plugin toolchain: `medusa
plugin:build` compiles src/ into .medusa/server, the package publishes only that build
output plus declarations, and consumers register
resolve: "medusa-payment-peach-payments/providers/peach" inside the Payment module's providers
array. Peer deps: @medusajs/framework and @medusajs/medusa ^2.13.0, Node >= 20. A boot
test on Medusa 2.17.2 already passed.

SINGLE CONCERN: package.json (exports map, files, scripts, peer/dev deps, engines),
tsconfig files, jest config, .github/workflows/, .gitignore, .nvmrc, and the consistency
of README install/registration instructions with what the package actually exports.

Required checks:
1. Exports map vs build output: every export subpath must resolve to a file the build
   actually produces (js AND the types condition to a real .d.ts). Flag any subpath that
   can 404 after install.
2. files field: nothing outside the intended artifact ships; nothing required at runtime
   is missing (LICENSE and README ship automatically).
3. Scripts: prepublishOnly guarantees a fresh build; test/typecheck/build commands exist
   and are coherent; the declarations pass cannot silently skip.
4. CI workflows: do the workflows actually fail on a test/typecheck/build failure (no
   swallowed exit codes, no continue-on-error); does the release workflow verify
   tag-matches-version before publish; is any secret echoed?
5. Peer range honesty: does the code import anything from @medusajs/* that did not exist
   in 2.13.0 (which would make ^2.13.0 a lie)?
6. README registration snippet: exactly matches the exported subpath and option names in
   src/providers/peach/types.ts.

OUT of scope (do NOT report as findings): the provider's business logic (separate runs),
examples/ code quality, docs prose style. The release workflow intentionally exists but
is unused until the owner approves publishing. verifications/ is a local audit trail, not
part of the package.

Verdict rules: NO-GO for a broken export path, a publish that would ship wrong/missing
files, CI that cannot fail, or a peer-range lie. LOW polish notes do not block.

Output template (end with exactly one verdict line):
FINDINGS: numbered list (severity, file:line, claim, evidence)
SOLID: what you verified holds
VERDICT: GO | NO-GO — CONFIRMED CRITICAL: n, HIGH: n, MEDIUM: n, LOW: n
