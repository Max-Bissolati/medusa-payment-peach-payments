# Backlog

## What's next

**Maintain and announce.** v0.1.0 is live on npm (published 2026-07-07 via the release
workflow with provenance) and the repo is public. Candidate next steps: submit the plugin
to Medusa's integrations listing, announce in the Medusa Discord and community channels,
and watch the issue tracker. The hardening list below is the code backlog.

## Hardening (LOW, non-blocking, from the verification loop)

All of these were confirmed non-exploitable by the reviewers who raised them; they are
polish, not fixes.

- OAuth token cache has no mutex: two concurrent calls can both fetch a token. Harmless
  (last write wins, both tokens valid) but a single-flight guard would be tidier
  (`src/providers/peach/lib/peach-client.ts`, getToken).
- `safeEq` reveals signature length mismatch by timing (standard practice; HMAC output
  length is public anyway) (`lib/verify-webhook.ts`).
- Malformed-input test matrices for `formatPeachAmount`/`amountsMatch` could be broader
  (NaN, Infinity, objects, exotic coercibles) (`lib/amount.ts` specs).
- `lastRefund.result` stores the raw Peach result object in payment data; consider
  trimming to code + description (`service.ts`, refundPayment).
- OAuth failure error message includes the HTTP status but not the Peach error body;
  helpful detail is logged only at debug level (`lib/peach-client.ts`).
- Declarations tsc pass emits no source maps; fine for a types-only artifact, note if
  debugging support is ever requested (`tsconfig.declarations.json`).
- 3DS challenge path was not exercised in sandbox E2E (the sandbox entity runs in
  Integrator Test Mode and auto-approves). Exercise it if Peach provides a
  challenge-enabled sandbox entity.

## Docs

- Done: README, `docs/WEBHOOKS.md`, and `examples/storefront/` (see CHANGELOG 2026-07-07).
- Possible follow-up: a heavily genericized Apple/Google Pay (Embedded Express) storefront
  example was skipped because the production reference is store-specific; revisit on demand.

## Decisions

- Multi-currency positioning: resolved as "document the limitation" (see the README's Limitations
  section) rather than add per-currency-decimals support. The amount handling works at cent
  granularity for 2-decimal currencies only (`amountsMatch` compares rounded cents,
  `formatPeachAmount` forces 2 dp); zero-decimal (JPY) and three-decimal currencies are
  unsupported. Revisit if a user actually needs one of those currencies.
- Publish identity: personal GitHub + npm, unofficial community plugin, plain-text
  "not affiliated with or endorsed by Peach Payments" disclaimer, no Peach branding.
