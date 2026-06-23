#!/bin/bash
# run-all.sh — the ONE command: scan all 15 boards → score vs your CV → tailor résumés →
# build the master workbook. Run from the repo root:  bash run-all.sh
#
# Browser boards run headless (no popup) where they can; Glassdoor/Wellfound run visible
# because they block headless. Each scanner is best-effort — a wall on one never stops the rest.

cd "$(cd "$(dirname "$0")" && pwd)" || exit 1
NODE="${NODE:-node}"
CAP="${1:-}"   # optional: cap new jobs per board, e.g.  bash run-all.sh 15

run() { echo "── $*"; $NODE "$@" $CAP 2>&1 | tail -2; echo; }

echo "===== SCAN — 15 boards ====="
# zero-token (no browser)
run scan-remote.mjs
run scan-simplyhired.mjs
run scan-foundit.mjs
# real browser, no login, headless
run scan-devops.mjs
run scan-indeed.mjs --headless
run scan-cutshort.mjs --headless
run scan-nodeflair.mjs --headless
# real browser + your session, headless
run scan-naukri.mjs --headless
run scan-hirist.mjs --headless
run scan-instahyre.mjs --headless
run scan-wellfound.mjs        # visible (rate-limits/session)
# visible (blocks headless)
run scan-glassdoor.mjs

echo "===== ACCUMULATE — keep every portal's full set ====="
$NODE accumulate.mjs 2>&1 | tail -3

echo "===== SCORE + TAILOR ====="
$NODE process-scans.mjs 2>&1 | tail -2
$NODE gen-pass-pdfs.mjs 2>&1 | tail -2

echo "===== WORKBOOK ====="
$NODE accumulate.mjs >/dev/null 2>&1   # push the new scores into the durable sidecar
$NODE build-workbook.mjs 2>&1 | tail -2

OUT="reports_stats/$(date +%F)/MASTER.xlsx"
echo
echo "✅ Done. Open: $OUT"
[ "$(uname)" = "Darwin" ] && [ -f "$OUT" ] && open "$OUT"
