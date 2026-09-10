# Independent adversarial verification: result-code mapping + overrides

**Scope:** `src/providers/peach/lib/result-codes.ts`, call sites in
`src/providers/peach/service.ts`, refund success check in
`src/providers/peach/lib/peach-client.ts`, and the result-code tests.
**Method:** re-derived every bucket by exhaustive enumeration (JS probes replicating the
module's exact regexes), traced every call chain by hand against the source, and ran the
test suite (101 tests, all green). No source files modified; no git state changed.

## FINDINGS

1. **LOW** — `service.ts:82-103` (`validateOptions`). Override **keys** are not validated,
   only **values**. A malformed key (whitespace, non-code string, typo) is silently inert
   because it can never equal a clean runtime `code` after the `\s` check, but it is dead
   config the merchant gets no signal about. Claim: "malformed override values are rejected
   at options-validation time" — this holds for values; keys are unchecked. Non-blocking:
   a malformed key cannot upgrade a decline to success (it simply never fires).

2. **LOW** — `peach-client.unit.spec.ts:340`. No direct regression test pinning
   "the refund path ignores `resultCodeOverrides` even when configured" (e.g. a test that
   sets `options.resultCodeOverrides = { "800.100.153": "captured" }` and asserts the refund
   STILL throws). The property is enforced **structurally** (see SOLID #3) and is covered
   indirectly by the no-override decline test, but an explicit pin would harden it against a
   future refactor that threads `this.options` into `isSuccessful`.

3. **LOW / observation** — `result-codes.ts:20`. The entire `000.3xx.xxx` and `000.6xx.xxx`
   bands map to `captured` (verified: all 2,000,000 codes in those bands return captured).
   The author documents these as Peach "manual review / chargeback handling that still
   settles as captured for DB". This is a *broad* success claim; without Peach's full
   authoritative codebook (out of scope here) I cannot falsify a specific stray sub-code.
   It does **not** violate fail-closed for codes *outside* the explicit success families
   (those still go to `error`). [INFERENCE] consistent with the documented design.

## SOLID (verified holds)

1. **Bucket regexes admit no wrong code.** Exhaustive enumeration of the `000.400.xxx` band:
   exactly **93** codes capture — `{000-029, 040-099}` (the `0[0-24-9]` class, excluding
   `030-039`), plus `100`, `110`, `120`. Everything else in the band → `error`. Probed
   unicode fullwidth digits (`０００.０００.０００`), letter lookalikes (`000.000.OOO`,
   `00О.000.000` with Cyrillic О), and every whitespace variant (leading/trailing space,
   `\t`, `\r`, `\r\n`, NBSP `\u00a0`, vertical tab, ideographic space `\u3000`): **all →
   `error`, none captured.** `000.100` is correctly narrowed to `000.100.1xx` only
   (`000.100.000`, `000.100.201`, `000.100.999` → `error`; `000.100.1{00..99}` → captured).

2. **`000.400.101` and `000.400.102` map to `error` at every call site.** `builtinStatus`
   returns `error` for both (they match no SUCCESS alternative and only `100`/`110`/`120`
   in the `1xx` third-segment of SUCCESS_REVIEW). All four consumer call sites route through
   `mapResultCodeToStatus`/`mapResultCodeToAction` → `builtinStatus` when no override is set:
   `authorizePayment` (`service.ts:179`), `getPaymentStatus` (`service.ts:220`), webhook body
   action (`service.ts:379`), webhook `/status` re-confirmation (`service.ts:401`). Without
   an explicit override, neither code can reach `authorized`/`captured`. (`builtinStatus`
   never returns `"authorized"` at all — only `captured`/`pending`/`requires_more`/
   `canceled`/`error`.)

3. **`resultCodeOverrides` cannot influence the refund success check.** Traced call chain
   (not comments): `service.ts:257` `refundPayment` calls
   `this.client_.refund(transactionId, amount, currency)` — **no overrides argument**.
   `peach-client.ts:292` `refund()` signature accepts **no overrides parameter**.
   `peach-client.ts:347` calls `isSuccessful(code)` with **one argument**, so the second
   `overrides` param is `undefined` → `mapResultCodeToStatus(code, undefined)` skips the
   override branch → `builtinStatus(code)`. Refund success therefore reduces to
   `builtinStatus(code) === "captured"`, which requires the code to be in SUCCESS ∪
   SUCCESS_REVIEW. A declined refund code (e.g. `800.100.153`) → throws. Confirmed by test
   `peach-client.unit.spec.ts:340`. Overrides ARE applied before buckets at the four
   intended sites (authorize/getStatus/webhook×2), and malformed values are rejected at
   `validateOptions` (legal-list enforced; non-string/`null`/number/`"banana"` all throw).

4. **Fail-closed defaults.** `undefined`/`null`/`""` → `pending` (never success; stalls
   `cart.complete` and the refund path throws on missing code). Any unknown/well-shaped
   code → `error`. `CODE_SHAPE = /^\d{3}\.\d{3}\.\d{3}$/` is fully anchored; empirically
   (V8/Bun) it rejects trailing `\n`, `\r\n`, embedded junk, and trailing non-digit chars
   unaided — the leading `/\s/` guard in `mapResultCodeToStatus` is pure defense-in-depth
   (runs first, also rejects). No path from junk/unknown/missing input to a success status.

5. **Tests pin the contract.** `result-codes.unit.spec.ts` pins the full captured table, the
   fail-closed codes (`101/102/103/104/107/121/199`, `000.100.000`, `000.100.2xx`),
   pending/requires_more/canceled/decline buckets, missing→pending, and the hardening junk
   inputs (trailing junk, newline, leading space, newline-embedded, non-digit `0X` class)
   for both `mapResultCodeToStatus` and `mapResultCodeToAction`. `result-code-overrides.unit.spec.ts`
   pins override-wins, non-overridden falls through, downgrade-no-warn, warn-once, and
   no-override equivalence. `peach-client.unit.spec.ts:340` pins refund-throws-on-decline.
   Suite: **101 passed, 0 failed.**

## VERDICT

GO — no confirmed path where a non-success code reaches `authorized`/`captured` except via
an explicit, warned merchant override (by design); overrides are structurally incapable of
reaching the refund success check. All three findings are LOW (non-blocking) hardening notes.

VERDICT: GO — CONFIRMED CRITICAL: 0, HIGH: 0
