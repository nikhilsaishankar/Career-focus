#!/bin/bash
# night-awake.sh — guarantee the hourly Naukri refresh runs overnight AND through
# the 05:00-11:00 morning window even when the Mac is UNPLUGGED (per user
# 2026-07-22: "whenever it is sleep the task must perform; only shutdown may
# error"; extended 2026-07-29: "must not skip any hour, especially 5-11am").
#
# Why: asleep on battery, macOS gives pmset scheduled wakes only a 2-12 second
# DarkWake — launchd jobs never run (root cause of the Jul 21/22 missed slots,
# and the 2026-07-29 04:00/05:00/06:00/07:00 gaps). There is NO way to get real
# runtime out of battery sleep, so instead we stop the Mac from idle-sleeping
# during refresh hours (20:00-11:00): hold a `caffeinate -i` assertion until
# 11:00. The display still sleeps; the system stays up and every hourly slot
# fires on time, plugged or not.
#
# Limits (hardware, cannot be overridden by ANY script): closing the lid (or
# Apple menu > Sleep) forces clamshell sleep, which ignores `caffeinate -i`
# entirely unless an external display is attached. The 2026-07-29 gaps happened
# INSIDE this held window, which means the lid was very likely closed at the
# time — no code fix changes that. Leave the lid open through 11:00, or attach
# an external display/dummy plug to keep clamshell-safe operation with the lid
# closed.
#
# Fired hourly at :57 (+ RunAtLoad) by com.nikhil.careerops-night-awake.plist;
# outside 20:00-11:00 it exits instantly. Single instance via PID file.

PIDFILE=/tmp/careerops-night-awake.pid
REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"   # repo root, wherever this is cloned
LOG="$REPO/data/night-awake.log"

H=$((10#$(date +%H)))
if [ "$H" -ge 20 ]; then
  end=$(date -v+1d -v11H -v0M -v0S +%s)  # tomorrow 11:00
elif [ "$H" -lt 11 ]; then
  end=$(date -v11H -v0M -v0S +%s)        # today 11:00
else
  exit 0                                  # daytime — nothing to do
fi
secs=$(( end - $(date +%s) ))
[ "$secs" -le 0 ] && exit 0

# already holding an assertion? (stale PID files are ignored via kill -0)
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] holding caffeinate -i for ${secs}s (until 11:00)" >> "$LOG"
echo $$ > "$PIDFILE"
exec /usr/bin/caffeinate -i -t "$secs"
