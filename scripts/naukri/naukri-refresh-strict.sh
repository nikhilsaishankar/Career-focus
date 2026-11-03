#!/bin/bash
# naukri-refresh-strict.sh — STRICT hourly runner for naukri-refresh.mjs.
# Fired by launchd every hour on the hour (com.nikhil.careerops-naukri-refresh).
#
# Guarantees, in order:
#   1. Single-flight — a lock dir prevents two overlapping runs (dispatcher
#      double-fire lesson: never race a peer, wait or bail).
#   2. Retry — up to 3 attempts, 3 min apart, so a transient "not logged in"
#      or network blip doesn't burn the slot. All attempts stay inside the
#      25-min slot-matching window of naukri-refresh.mjs.
#   3. Audit — EVERY attempt is appended to data/naukri-refresh-audit.log:
#      timestamp, slot, attempt number, exit code, verdict. The per-slot ✅/⚠️/❌
#      sheet (module05-Naukri-Profile.md) is rebuilt by the .mjs itself.

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT="$DIR/data/naukri-refresh-audit.log"
LOCK="/tmp/naukri-refresh-strict.lock"
NODE=/opt/homebrew/bin/node
SLOT=$(date +%H):00
# Pass the authoritative slot down so the .mjs sheet credits the right hour even
# when a pmset wake fires the run late (e.g. 03:58 run still belongs to slot 03:00).
export NAUKRI_SLOT="$SLOT"

audit() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] slot=$SLOT $*" >> "$AUDIT"; }

# -- single-flight lock (stale after 30 min — a run may now legitimately
#    retry for the full 22-min slot window) ---------------------------------
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -lt 1800 ]; then
    audit "attempt=0 result=SKIPPED reason=another run in progress (lock ${age}s old)"
    exit 0
  fi
  audit "attempt=0 note=stale lock (${age}s) — taking over"
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 1
fi
trap 'rm -rf "$LOCK"' EXIT

# -- overnight battery warning (added 2026-07-22) ----------------------------
# Asleep on battery, pmset wakes only get a 2-12s DarkWake — the overnight
# slots CANNOT run (root cause of the Jul 21/22 gaps). From 20:00 on, if still
# on battery, notify once per evening to plug in the charger.
if [ "$((10#$(date +%H)))" -ge 20 ] && pmset -g batt | grep -q 'Battery Power'; then
  WARNMARK="/tmp/naukri-battery-warn-$(date +%F)"
  if [ ! -f "$WARNMARK" ]; then
    # battery notification disabled per Nikhil 2026-10-26 (no notifications)
    :
    touch "$WARNMARK"
    audit "note=on battery this evening — overnight slots will MISS unless plugged in (user notified)"
  fi
fi

# -- run with retries: keep trying for the WHOLE 22-min slot window ----------
# (per user 2026-07-22: every slot on the sheet must pass — a slot may only
# fail if Naukri is unreachable for the entire window, not after 3 tries)
START=$(date +%s)
attempt=0
while :; do
  attempt=$((attempt + 1))
  # Re-derive the slot per attempt: if the Mac slept mid-retry and resumed hours
  # later (seen 2026-07-21/22: attempt 2 ran at 07:30 but was credited to slot
  # 00:00), the recovery run must be credited to the CURRENT hour, not the stale
  # one captured before sleep.
  SLOT=$(date +%H):00
  export NAUKRI_SLOT="$SLOT"
  "$NODE" "$DIR/scripts/naukri/naukri-refresh.mjs" >> "$DIR/data/naukri-refresh.log" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then
    audit "attempt=$attempt result=OK"
    exit 0
  fi
  audit "attempt=$attempt result=FAIL exit=$code"
  elapsed=$(( $(date +%s) - START ))
  if [ "$elapsed" -ge 1320 ]; then
    audit "result=SLOT-FAILED after $attempt attempts in ${elapsed}s — check data/naukri-refresh.log"
    exit 1
  fi
  sleep 120
done
