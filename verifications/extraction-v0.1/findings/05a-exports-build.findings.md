# 05a — Exports map + build artifact (independent adversarial verification)

Independent verifier. Re-derived every result from the checked-out working tree
(commit `25be8ad`). No git state changed, no application source modified. One
pre-existing untracked probe (`src/providers/peach/__tests__/_probe.action-flow.spec.ts`)
and the `verifications/` tree were present as checked out and left untouched.

Scope: `package.json` + `tsconfig.json` + `tsconfig.declarations.json` ONLY.

---

## FINDINGS

1. **MEDIUM — package.json:26-29 (`"./*"` catch-all export advertises subpaths that
   cannot resolve).** The catch-all maps `medusa-payment-peach-payments/<x>` to
   `.medusa/server/src/<x>.d.ts` / `.js`. The build emits `index.{js,d.ts}` files, so
   any subpath whose module is a directory resolves to a nonexistent file:
   - `medusa-payment-peach-payments/admin` → `.medusa/server/src/admin.{d.ts,js}` — build actually
     produces `admin/index.js` + `admin/index.mjs` (no `admin.js`/`admin.d.ts`). Importing
     it would throw `ERR_MODULE_NOT_FOUND`.
   - `medusa-payment-peach-payments/providers/peach/lib/amount` via `./providers/*` (`*` =
     `peach/lib/amount`) → `providers/peach/lib/amount/index.d.ts` — build produces
     `amount.d.ts`, not `amount/index.d.ts`. Same failure.
   **Why non-blocking:** the catch-all is inert for the one documented consumer path
   (`medusa-payment-peach-payments/providers/peach`, see #2), Medusa admin extensions are framework-
   discovered rather than `import`-resolved, and `lib/*` is internal. No consumer is
   directed at these subpaths. The shape is misleading/defensive-gap, not a broken ship
   path. Recommend dropping `"./*"` or pointing it at `*/index.{js,d.ts}`.

   (Note on `providers/peach` itself: under Node's subpath-pattern resolution,
   `./providers/*` (line 22) is consulted before `./*` and `*`=peach yields real files, so
   the catch-all never shadows the documented entry. Verified by file existence, not by
   executing Node — see SOLID #1.)

2. **LOW — package.json:14 (`engines.node ">=20"` vs `@types/node ^20`).** Consistent and
   fine; the `.nvmrc` agrees (Node 20 line). Listed only for completeness — not a defect.

3. **LOW — `tsc -p tsconfig.declarations.json` emits no source maps / has
   `declaration:false` inherited then overridden.** Correct by construction
   (`declaration:true` + `emitDeclarationOnly:true` in the declarations file overrides the
   base). Not a defect; recorded because check 3 explicitly asked about a possible silent
   no-op — see SOLID #4.

---

## SOLID (verified to hold)

1. **Documented export resolves to real build artifacts.** Consumer contract is
   `medusa-payment-peach-payments/providers/peach`. `exports["./providers/*"]` with `*`=peach:
   - `types` → `.medusa/server/src/providers/peach/index.d.ts` — EXISTS (461 B, real
     declaration: `declare const _default: import("@medusajs/types").ModuleProviderExports;
     export default _default;` + type re-exports).
   - `default` → `.medusa/server/src/providers/peach/index.js` — EXISTS (1047 B).
   Both targets confirmed present after the build that produced `.medusa/server`.

2. **`files` ships exactly `.medusa/server` and nothing else.** No `src/`, no `__tests__/`,
   no `examples/`, no `docs/`. Every spec file lives under `src/.../__tests__/`, which is
   outside `.medusa/server`, so tests cannot ship. `package.json` itself is always
   included by npm regardless of `files`, satisfying `exports["./package.json"]`. Nothing
   required at runtime is excluded (runtime needs only build output + peers + node builtins,
   all available).

3. **Zero runtime dependencies — confirmed at two levels.**
   - Manifest: `package.json` has NO `dependencies` field (grep for `dependencies` found
     only `peerDependencies` / `devDependencies`).
   - Source: every external (non-relative) specifier across the shipped source
     (`index.ts`, `service.ts`, `types.ts`, `lib/amount.ts`, `lib/peach-client.ts`,
     `lib/result-codes.ts`, `lib/verify-webhook.ts`) is exactly:
     `@medusajs/framework/types`, `@medusajs/framework/utils`, `crypto` (node builtin).
     No third-party runtime import exists. (The `medusa-payment-peach-payments/providers/peach`
     text hit is a doc comment in `index.ts:14`, not an import.)

4. **Scripts coherent; declarations pass cannot silently no-op.**
   - `build` = `medusa plugin:build && tsc -p tsconfig.declarations.json`. The second
     command inherits `include: ["src"]` (matches many files) with `declaration:true` +
     `emitDeclarationOnly:true` (overrides base `declaration:false`) and no `noEmit`. With
     matched inputs and forced declaration emission it must emit, so a no-op is not
     possible. Confirmed empirically: every shipped `.ts` has a corresponding non-empty
     `.d.ts` (`index` 461 B, `service` 4100 B, `types` 4413 B, `lib/*` 572-2912 B) in
     `.medusa/server`.
   - `prepublishOnly` = `npm run build` (rebuilds before publish). ✓
   - `test` (`jest`) and `typecheck` (`tsc --noEmit`) both present. ✓

5. **Peer range `^2.13.0` is honest.** Source imports from `@medusajs/framework/utils`:
   `ModuleProvider`, `Modules`, `AbstractPaymentProvider`, `BigNumber`, `MedusaError`; from
   `@medusajs/framework/types`: `PaymentSessionStatus`, `PaymentActions`, `Logger`,
   `BigNumberInput`, and the standard payment `*PaymentInput`/`*PaymentOutput` +
   `WebhookActionResult` shapes. All are foundational Medusa v2 payment-provider APIs,
   present well before 2.13.0 (none are patch-introduced in 2.13.1). Independent
   corroboration: a boot test on a real Medusa app passed and a strict-TS consumer probe
   compiled against the packed tarball resolving `@medusajs/framework@2.13.1` — i.e. these
   symbols are confirmed available at the 2.13.x line the peer range admits. No symbol was
   found that would require a newer minimum than 2.13.0.
   [INFERENCE] Exact introduction versions were not pulled from per-symbol changelogs;
   conclusion rests on (a) the symbols being long-standing core APIs and (b) the two
   independent runtime/type checks above.

6. **No `src` top-level `lib/` directory exists; the `lib/` referenced by the brief lives
   at `src/providers/peach/lib/`.** All four modules there (`amount`, `peach-client`,
   `result-codes`, `verify-webhook`) compile to `.js`+`.d.ts` pairs under
   `.medusa/server/src/providers/peach/lib/`. Nothing is missing.

---

## VERDICT

GO — CONFIRMED CRITICAL: 0; HIGH: 0; MEDIUM: 1; LOW: 2

Rationale: the one consumer-facing ship path (`medusa-payment-peach-payments/providers/peach`,
both `types` and `default`) resolves to real, content-verified build artifacts. The
package ships exactly `.medusa/server` with no source/test/example leakage, has zero
runtime dependencies (manifest + source both clean), peer range is honest, and the build
scripts are coherent with no silent-no-op path for the declarations pass. The single
MEDIUM is the `./*` catch-all, which advertises resolvable-but-nonexistent subpaths
(`admin`, deep `lib/*`) — a real but inert defect on undocumented paths; it does not break
the advertised install and was independently cleared by the prior boot test + TS probe.
