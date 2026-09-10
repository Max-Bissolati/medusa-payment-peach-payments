#!/bin/sh
# Compare this plugin's provider source against an in-tree copy in a private store
# (the build this plugin was extracted from). Reports drift so fixes get ported
# both ways. Known intentional deltas (config options, scrubbed comments) will
# show up too; judge hunks, don't count lines.
#
# Usage: SOURCE_DIR=/path/to/store/src/modules/payment-peach scripts/check-drift-vs-source.sh
set -eu

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/providers/peach"
SOURCE_DIR="${SOURCE_DIR:-/Volumes/X10 Pro/DEV Projects/Mahdiyeh Pakdoust OpenClaw/medusa-backend/src/modules/payment-peach}"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "source dir not found: $SOURCE_DIR (set SOURCE_DIR)" >&2
  exit 2
fi

status=0
for f in service.ts types.ts lib/peach-client.ts lib/result-codes.ts lib/verify-webhook.ts lib/amount.ts; do
  if [ ! -f "$SOURCE_DIR/$f" ]; then
    echo "MISSING in source: $f"
    status=1
    continue
  fi
  if ! diff -q "$SOURCE_DIR/$f" "$PLUGIN_DIR/$f" >/dev/null 2>&1; then
    echo "DRIFT: $f"
    diff -u "$SOURCE_DIR/$f" "$PLUGIN_DIR/$f" | head -40
    echo "---"
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "No drift: plugin matches the source module byte for byte."
else
  echo ""
  echo "Drift found. Expected deltas: defaultCurrency/defaultCountryCode/resultCodeOverrides"
  echo "options, scrubbed comments, currency normalization. Anything else needs porting."
fi
exit "$status"
