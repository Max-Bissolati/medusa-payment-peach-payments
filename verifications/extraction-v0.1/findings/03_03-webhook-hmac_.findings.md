# Independent adversarial verification: webhook HMAC + webhook action flow

Scope: `src/providers/peach/lib/verify-webhook.ts`,
`getWebhookActionAndData` in `src/providers/peach/service.ts`, and their tests.
Branch verified: `main` (working tree clean except untracked
`src/providers/peach/__tests__/_probe.action-flow.spec.ts` and `verifications/`,
neither touched). No source files modified. Evidence gathered via code read +
in-kernel crypto probes + the two in-scope jest specs (26/26 pass).

## FINDINGS

1. LOW — `verify-webhook.ts:23-30` (`safeEq`). The timing-safe compare leaks the
   signature *length* via the `ab.length !== bb.length` early-return before
   `crypto.timingSafeEqual`. This is the canonical required pattern
   (`timingSafeEqual` mandates equal-length buffers) and is NOT exploitable for
   HMAC forgery: the attacker cannot compute the digest without the secret, so
   leaking the digest length yields nothing. Non-blocking hardening note.

2. LOW — `verify-webhook.ts:42-61, 102-124`. The classic signed message is
   `sorted entries.map(k+v).join("")` with NO delimiters, so the canonicalization
   is non-injective. Empirically confirmed: bodies `a=bc&d=e` and `a=b&cde=`
   both produce message `"abcde"`, so a captured signature for one validates the
   other. This is the known weakness the code comments flag and that the
   `/status` re-confirmation exists to neutralize. CRUCIALLY, because the
   attacker can only *repartition* the fixed signed message bytes (not inject
   new bytes), any colliding body's field values are constrained to substrings
   of the original message — the attacker cannot plant an arbitrary
   `checkoutId` or `session_id`. So the `/status` call stays (transitively)
   keyed on the original checkout. Acceptable given the `/status` binding. Not a
   bypass.

3. LOW — `service.ts:422-432`. `confirmedSession = confirmed.medusaSessionId ??
   sessionId` lets the body's `customParameters[medusaSessionId]` flow into the
   emitted `data.session_id` when `/status` omits `medusaSessionId`. This is the
   ONLY body field that can appear in emitted data. It is conditional on (a) a
   captured valid signature, (b) `/status` stripping `customParameters`, and (c)
   downstream session/amount reconciliation not catching it. Combined with
   Finding 2, the leaked value is byte-bound to the signed message (not an
   attacker-chosen target session), so it cannot route completion to a chosen
   cart. Money-side (`action`, `amount`) stays `/status`-bound. Non-blocking.

4. LOW — `verify-webhook.ts:106-109`. Array / object / number / empty
   `signature` values in the parsed-body path are correctly rejected by the
   `typeof signature !== "string" || !signature` guard (verified empirically:
   `{signature:["x"]}` → rejected). No unit test explicitly pins the
   array-valued-signature rejection. Test-coverage gap only; code is correct.

5. LOW — `verify-webhook.ts:26`. A wrong-LENGTH provided signature is handled
   correctly (`ab.length !== bb.length` → `false`, no throw — verified
   empirically). No unit test pins a length-mismatched signature explicitly
   (existing "tampered body" tests produce a same-length wrong digest). Test-
   coverage gap only; code is correct.

## SOLID

- `safeEq` uses `crypto.timingSafeEqual` with an equal-length precheck; it is
  never reached with an empty computed digest (HMAC hex is always 64 chars /
  base64 88). Length mismatch returns `false` without throwing (verified).

- Every signature entry point guards missing/empty/non-string signatures BEFORE
  any HMAC comparison: `verifyClassic` (`!signature`, line 45),
  `verifyClassicFromParsed` (`typeof !== "string" || !signature`, line 107),
  `verifyModern` (only entered when `headerSig` truthy, line 201). No path
  defaults to accepted when secret or signature is absent.

- `verifyPeachWebhook` fails CLOSED with no secret: `!secretToken` →
  `{valid:false, reason:"no_secret_configured"}` (line 176). Unverifiable
  signature → `getWebhookActionAndData` returns `{action:"not_supported"}` and
  never calls `/status` (service.ts:349-352; test webhook-action:47-59).

- Parsed-body reconstruction matches raw-body signing for nested (bracket
  `customParameters[medusaSessionId]`), dotted (`result.code`,
  `recon.authCode`), repeated/array keys, empty values, `+`→space, and UTF-8
  unicode (per code + verify-webhook parsed tests, all green). No attacker WIN
  is possible: HMAC unforgeability holds regardless of canonicalization; the
  canonicalization only enables same-message replay, which `/status`
  neutralizes, and repartitioning cannot inject arbitrary field values.

- Emitted `action` = `mapResultCodeToAction(confirmed.resultCode)` from `/status`
  (service.ts:401-404, 427). Emitted `amount` = `BigNumber(Number(confirmedAmount))`
  from `/status` with NO body fallback (service.ts:415-421). The body `amount`
  is never read for the emitted data. Pinned by webhook-action:175-194 and the
  bypassed-signature probe (101-115).

- Body `result.code` is used ONLY as a gate (`bodyAction` must be
  `authorized`/`captured` to proceed; service.ts:379-385); it is NOT emitted.
  Missing / whitespace-bearing / malformed body code → `pending`/`error` →
  `not_supported` BEFORE any `/status` call (result-codes.ts:47 CODE_SHAPE,
  72-80; verified mapResultCodeToAction(undefined) → "pending"). No
  `"000.000.000\n<junk"` success injection.

- All failure modes return `not_supported`, never a success/captured action:
  missing `sessionId` (368-373), missing `checkoutId` with `/status` never
  called (390-393), `/status` throw (397-400), `/status` non-success resultCode
  (405-410), `/status` with no/empty amount and no body-amount fallback
  (416-421). All pinned by `webhook-action.unit.spec.ts` (26/26 pass).

- The modern header scheme (`verifyModern`) is reached only when classic did
  not validate; it independently HMACs `rawBody` under the same secret. No
  cross-scheme confusion and no fail-open (an invalid modern sig returns
  `signature_mismatch`, line 206).

## VERDICT: GO — CONFIRMED CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 5
