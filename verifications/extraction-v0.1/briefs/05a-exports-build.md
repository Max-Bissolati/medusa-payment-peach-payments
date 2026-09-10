# Independent adversarial verification: exports map + build artifact

You are an INDEPENDENT, ADVERSARIAL verifier. Another model packaged this Medusa v2
payment provider plugin and claims the published artifact is a drop-in install. Do not
trust it. Re-derive every result. Return GO or NO-GO.

System (1 para): medusa-payment-peach-payments builds with `medusa plugin:build` plus a
declarations-only tsc pass into .medusa/server; the package publishes only that output.
Consumers resolve "medusa-payment-peach-payments/providers/peach". A boot test on a real Medusa
app already passed, and a strict-TS consumer probe compiled against the packed tarball.

SINGLE CONCERN: package.json (name, files, exports, scripts, dependencies/peer/dev,
engines) and the two tsconfig files ONLY. Do not review workflows, README, or src logic.

Required checks:
1. Every exports subpath (types and default conditions) must point at a file the build
   actually produces under .medusa/server. Flag any path that cannot exist after
   `npm run build`.
2. files field: ".medusa/server" only; confirm nothing required at runtime is excluded
   and nothing unintended (specs, examples, src) can ship.
3. Scripts coherence: build runs plugin:build then the declarations pass; prepublishOnly
   rebuilds; test/typecheck exist. Can the declarations pass silently no-op?
4. Peer-range honesty: the source imports from @medusajs/framework/utils and /types --
   are any imported symbols newer than 2.13.0 (which would make peer ^2.13.0 wrong)?
   Check the actual import statements in src/providers/peach/*.ts and lib/*.ts.
5. Zero runtime dependencies is claimed: verify no src import needs a package outside
   @medusajs/* peers and node builtins.

OUT of scope: CI workflows, README/docs, examples/, business logic, tests' content.

Verdict rules: NO-GO only for a confirmed broken export/ship path or peer-range lie.
LOW polish notes do not block.

Output template (end with exactly one verdict line):
FINDINGS: numbered list (severity, file:line, claim, evidence)
SOLID: what you verified holds
VERDICT: GO | NO-GO — CONFIRMED CRITICAL: n, HIGH: n, MEDIUM: n, LOW: n
