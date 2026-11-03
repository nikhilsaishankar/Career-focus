#!/bin/bash
# apply-all.sh — apply to the GREEN (Ready-to-apply, ATS >= 75%) jobs across every portal you're
# logged into, then refresh the date-wise tracker. Run this when YOU'RE present (it opens a
# real browser per portal and submits real one-click applies — anything with screening
# questions is HELD, not submitted).
#
#   bash apply-all.sh          # apply across all portals' green jobs
#   bash apply-all.sh --dry    # locate Apply on each, submit nothing (safe preview)
#
# Scheduled scans stay headless / no-popup; APPLYING is deliberate and lives here.

cd "$(cd "$(dirname "$0")/../.." && pwd)" || exit 1
NODE="${NODE:-node}"
DRY=""; [ "$1" = "--dry" ] && DRY="--dry"

# portals that have an apply agent (more get added as they're built)
for portal in hirist instahyre; do
  agent="scripts/apply/apply-$portal.mjs"
  [ -f "$agent" ] || continue
  echo "═══ $portal ═══"
  $NODE "$agent" $DRY 2>&1 | grep -E '🎯|▶|✅|⏸|⛔|applied|held' | tail -20
  echo
done

# refresh outputs so the sheet/tracker reflect what was just applied
$NODE scripts/scan/accumulate.mjs >/dev/null 2>&1
$NODE scripts/sheets/build-workbook.mjs >/dev/null 2>&1
$NODE scripts/sheets/build-tracker.mjs 2>&1 | tail -2
echo "✅ tracker updated — open reports_stats/$(date +%F)/TRACKER.xlsx"
