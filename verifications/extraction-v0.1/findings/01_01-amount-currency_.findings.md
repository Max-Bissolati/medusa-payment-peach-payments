# Independent adversarial verification: amount integrity + currency handling

Scope: `src/providers/peach/lib/amount.ts`, the `resolveCurrency`/`initiatePayment`/`refundPayment`
currency logic in `src/providers/peach/service.ts`, currency parts of `src/providers/peach/lib/peach-client.ts`,
and their tests. Re-derived from source; malformed-input and float-safety classes confirmed with a temporary
jest probe against the REAL modules (then deleted). Webhook/OAuth/result-code/packaging out of scope.

## FINDINGS

1. **LOW — `amountsMatch` does not reject exotic/coercible inputs that `Number()` parses to a real value.**
   `src/providers/peach/lib/amount.ts:40-45`. The comparison path is `Number(a)` / `Number(b)` after the
   empty/finite guards. JS coercion means some "malformed" inputs parse to a number and can match:
   `amountsMatch([1400], "1400.00") === true` (single-element array; `Number([1400])===1400`),
   `amountsMatch("0x10", "16.00") === true` (hex), `amountsMatch("1e2", "100.00") === true` (scientific),
   `amountsMatch("16.", "16.00") === true`. Probe-confirmed.
   *Why this does NOT block:* every `amountsMatch` call site passes `string | undefined`. The sole call site is
   `service.ts:197` — `status.amount` (always `String(amountRaw)` or undefined per `peach-client.ts:227`) and
   `expected` (`input.data?.amount as string | undefined`, written at initiate by `formatPeachAmount`). Arrays /
   hex / objects cannot reach the function through the production path. This is a defense-in-depth gap, not a
   confirmed authorize path. Suggest a `typeof a === "number" || typeof a === "string"` guard (or reject non-string
   outright) so a future call-site change can't silently introduce a coercion match.

2. **LOW — `formatPeachAmount` malformed-input matrix is under-tested.**
   `src/providers/peach/__tests__/amount.unit.spec.ts:32-36`. The "throws on negative or non-finite" test pins
   only `-1`, `NaN`, `+Infinity`. Probe-verified that `null`, `undefined`, `""`, `"  "`, `"123abc"`, `"abc"`,
   `"1,400.00"`, `"1.400,00"`, `{}` ALSO throw (all via the Medusa `BigNumber` constructor / `bignumber.js`,
   which rejects them) — so the *behavior* is correct and fail-closed, but no regression test would catch a
   refactor that silently started coercing these. The amount-integrity gate is the load-bearing safety property;
   the malformed-input matrix is exactly the adversarial surface, so it deserves a pinned case per class.

3. **LOW — `amountsMatch` malformed-input matrix is under-tested.**
   `src/providers/peach/__tests__/amount.unit.spec.ts:52-68`. Pinned: `undefined`, `null`, `""`, `"abc"`, `NaN`,
   and whitespace-only. NOT pinned: `Infinity`, negative-vs-positive, junk-numeric-string (`"123abc"`), object,
   array (see finding 1). Behavior is correct for the in-scope classes (probe: all return `false`), but coverage
   is incomplete on the money-safety comparison.

No other confirmed issues. No malformed-input class in the brief's enumeration authorizes; no malformed currency
reaches the network (see SOLID).

## SOLID (verified holds)

**`formatPeachAmount` (`amount.ts:10-22`)**
- Rejects EVERY enumerated malformed class — `null`, `undefined`, `""`, whitespace, `NaN`, ±`Infinity`, negative,
  junk strings (`"123abc"`, `"abc"`, comma/European decimals), `{}`, and duck-typed `{numeric:…}` — by throwing
  (constructor / `bignumber.js` rejection, then the explicit `!Number.isFinite` and `< 0` guards). Probe-verified.
- No ×100 (the classic Peach bug); `15000 → "15000.00"`. Major-unit, exactly 2 dp.
- Float-exact at realistic magnitudes: `999999999.99 → "999999999.99"`, `999999999.98` distinct; `100000000 →
  "100000000.00"`. The classic float traps are correct: `0.06 → "0.06"`, `0.1+0.2 → "0.30"`, `2.675 → "2.68"`,
  `19.99 → "19.99"`. At 9-digit major units `numeric*100 ≤ ~1e11 ≪ 2^53`, so `Math.round` is exact; two distinct
  cent amounts cannot collide and no amount rounds to the wrong cent. The Medusa `BigNumber.numeric` epsilon
  (≤0.0001 → 0) is benign here: only sub-cent values zero, which correctly round to `"0.00"` anyway.

**`amountsMatch` (`amount.ts:29-46`) — the authorize gate**
- Fails CLOSED on every enumerated malformed class: `null`, `undefined`, `""`, whitespace (trimmed BEFORE the
  empty check, defeating the `Number(" ")===0` trap — explicitly commented and tested), `NaN`, ±`Infinity`, junk
  (`"abc"`, `"123abc"`), comma/European decimals, `{}`. Probe-verified all return `false`.
- Cent-granular (`Math.round(n*100)`); float-safe at 9 digits (probe: `999999999.99` vs `.98` distinct; same-cent
  `123456789.01` vs `123456789.014` correctly match). Trims surrounding whitespace before comparing, so
  `" 1400.00 "` still matches `"1400.00"` (valid input) — correct.
- `authorizePayment` (`service.ts:195-203`) runs the gate ONLY for `mapped === "authorized"|"captured"`, returns
  `error` on any mismatch OR missing/junk Peach amount, and passes non-success outcomes through ungated (they do
  not authorize). So a success code alone never completes the order.

**Currency resolution (`service.ts:116-131`, `peach-client.ts:292-311`)**
- `resolveCurrency` validates the RESOLVED value, not just the input: `(fromInput || defaultCurrency || "")
  .toUpperCase()`, then `if (!currency) throw`, then `/^[A-Z]{3}$/.test(currency) || throw`. Lowercase →
  uppercase; 2/4-letter, numeric, accented, whitespace-padded, empty all throw. Verified by tests
  (`options-defaults.unit.spec.ts:136-156`).
- `initiatePayment` (`service.ts:134-139`) resolves currency BEFORE `createCheckout` (the only network call).
- `refundPayment` (`service.ts:253-257`) resolves currency BEFORE `client_.refund`.
- Defense in depth: `PeachClient.refund` (`peach-client.ts:301-311`) re-resolves (`currency || defaultCurrency`)
  and re-validates `/^[A-Z]{3}$/` BEFORE signing or the `fetch`. So a malformed currency cannot reach the wire on
  either path. Tests pin both service-level (`mockRefund not called`) and client-level (no refund `fetch`) throw
  points, plus the defaultCurrency-fallback and lowercase→uppercase behaviors
  (`options-defaults.unit.spec.ts:47-134`, `peach-client.unit.spec.ts:300-332`).

**Regression coverage of the core guarantees**
- `formatPeachAmount`: no-×100, 2-dp, defensive rounding, accepts string/`BigNumber`, throws on
  negative/non-finite (`amount.unit.spec.ts:4-37`).
- `amountsMatch`: equal across string/number/formatting, 1-cent sensitivity, fail-closed on
  missing/empty/non-finite and whitespace-only (`amount.unit.spec.ts:39-74`).
- `authorizePayment` gate: success+match → `captured`; success+mismatch → `error`; success+missing amount →
  `error`; non-success → `pending` (ungated, correct) (`service.unit.spec.ts:134-206`).
- Currency: non-3-letter throws before network on BOTH initiate and refund; defaultCurrency fallback validated;
  lowercase → uppercase (`options-defaults.unit.spec.ts:47-157`, `peach-client.unit.spec.ts:266-345`).

## VERDICT: GO — CONFIRMED CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 3
