#!/bin/bash
# schedule-wakes.sh — registers pmset wake events so the Mac wakes from SLEEP
# 2 minutes before each naukri-refresh slot (launchd then fires the refresh).
# Runs as root via /Library/LaunchDaemons/com.nikhil.careerops-wake-scheduler.plist
# (RunAtLoad + daily 00:05; missed runs coalesce onto next wake).
# Covers today's remaining slots + all of tomorrow, so an evening run already
# has the next morning armed before the overnight sleep.
# Does NOT power on a shut-down Mac — Apple Silicon can't schedule power-on.
# Dry run (no root needed): DRYRUN=1 ./schedule-wakes.sh

# STRICT hourly slots (per user 2026-07-16) — one wake per hour, round the clock
SLOTS=$(for h in $(seq 0 23); do printf "%02d:00 " "$h"; done)
LEAD=120   # seconds before the slot to wake
REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"   # repo root, wherever this is cloned
LOG="$REPO/data/wake-scheduler.log"

now=$(date +%s)
existing=$(pmset -g sched 2>/dev/null)
scheduled=0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

for day in 0 1; do
  daystr=$(date -j -v+${day}d +%m/%d/%y)
  for slot in $SLOTS; do
    target=$(date -j -f "%m/%d/%y %H:%M:%S" "$daystr $slot:00" +%s) || continue
    wake=$((target - LEAD))
    # skip slots already past (60s grace)
    [ "$wake" -le $((now + 60)) ] && continue
    wakestr=$(date -j -f "%s" "$wake" +"%m/%d/%y %H:%M:%S")
    # skip if an event at this exact time is already queued (dedup across reruns).
    # NOTE: pmset -g sched prints 4-digit years, so compare with %Y — comparing the
    # %y form never matched and every rerun queued duplicate wakes.
    dedupstr=$(date -j -f "%s" "$wake" +"%m/%d/%Y %H:%M:%S")
    if echo "$existing" | grep -qF "$dedupstr"; then
      continue
    fi
    if [ -n "$DRYRUN" ]; then
      echo "would schedule: wake at $wakestr"
    else
      if pmset schedule wake "$wakestr" 2>>"$LOG"; then
        scheduled=$((scheduled + 1))
      else
        log "FAILED to schedule wake at $wakestr"
      fi
    fi
  done
done

[ -z "$DRYRUN" ] && log "scheduled $scheduled new wake event(s)"
exit 0
