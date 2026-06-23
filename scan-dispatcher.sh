#!/bin/bash
# scan-dispatcher.sh — the "when the Mac is on, everything runs" engine.
#
# The problem it solves: macOS launchd does NOT replay calendar jobs that were
# missed while the Mac was asleep or powered off. So if the Mac is off at 07:00,
# the morning scan is lost forever and the sheets stay empty.
#
# This dispatcher is launched every 30 min AND at login/wake (RunAtLoad). On each
# run it checks the three daily review slots (morning/afternoon/night). For any
# slot whose time has already passed today and that has NOT yet run, it runs the
# full scan batch and drops a marker so it never double-runs. Result: open the
# laptop any time after 07:00 and the morning slot fires within ~30 min (or
# instantly on login).
#
# Disable anytime:
#   launchctl unload ~/Library/LaunchAgents/com.nikhil.careerops-dispatcher.plist

cd "$(cd "$(dirname "$0")" && pwd)" || exit 1
export PATH="/Users/nikhil_kotharu/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

NODE=/opt/homebrew/bin/node
LOG=data/dispatcher.log
MARKDIR=data/.dispatch
mkdir -p "$MARKDIR" data

TODAY=$(date +%F)
NOW_MIN=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))

# slot name -> start minute-of-day. A slot is "due" once NOW is past its start.
run_slot() {
  local slot=$1 start=$2
  local mark="$MARKDIR/$TODAY-$slot"
  [ "$NOW_MIN" -lt "$start" ] && return 0          # not time yet today
  [ -f "$mark" ] && return 0                       # already ran this slot today

  echo "===== $(date) dispatcher: running slot '$slot' =====" >> "$LOG"

  # 1) LinkedIn scan (module01)
  bash daily-devops.sh >> data/devops-scan.log 2>&1
  # 2) Naukri job scan (module04)
  "$NODE" scan-naukri.mjs --headless >> data/naukri-scan.log 2>&1
  # 3) Naukri profile refresh (module05) — keeps you fresh in recruiter searches
  "$NODE" naukri-refresh.mjs >> data/naukri-refresh.log 2>&1
  # 4) Remote boards (module07) — RemoteOK/Remotive/Himalayas/WWR, zero-token public APIs
  "$NODE" scan-remote.mjs >> data/remote-scan.log 2>&1
  # 5) SimplyHired India (module08) — zero-token server-rendered HTTP scan
  "$NODE" scan-simplyhired.mjs >> data/simplyhired-scan.log 2>&1
  # 6) Glassdoor India (module09) — real Chrome + saved session
  "$NODE" scan-glassdoor.mjs >> data/glassdoor-scan.log 2>&1
  # 7) Cutshort (module10) — real Chrome, public SPA listing
  "$NODE" scan-cutshort.mjs --headless >> data/cutshort-scan.log 2>&1
  # 8) Indeed (module11) — real Chrome, homepage-first to clear Cloudflare
  "$NODE" scan-indeed.mjs --headless >> data/indeed-scan.log 2>&1
  # 9) Wellfound (module12) — real Chrome + saved session (rate-limits if hit too often)
  "$NODE" scan-wellfound.mjs >> data/wellfound-scan.log 2>&1
  # 9b) Foundit (module13) — zero-token middleware API (ex-Monster India)
  "$NODE" scan-foundit.mjs >> data/foundit-scan.log 2>&1
  # 9c) NodeFlair (module14) — real Chrome, public SPA (Cloudflare-walled to plain fetch)
  "$NODE" scan-nodeflair.mjs --headless >> data/nodeflair-scan.log 2>&1
  # 10) FAST deterministic scoring — ATS + JD-fit + insight + résumé-PDF for every job that has a
  #     JD/skills (zero-token), written back into data/*-scan.json.
  "$NODE" process-scans.mjs >> data/auto-process.log 2>&1
  # 11) AGENT pass — fills the rest (jobs with no JD → WebFetch + score) + web-searches walled boards.
  bash auto-process.sh
  # 12) MASTER workbook LAST — reads the now-processed scan JSON → filled funnel per platform tab
  "$NODE" build-workbook.mjs >> data/master-sheet.log 2>&1

  touch "$mark"
  echo "===== $(date) dispatcher: slot '$slot' done =====" >> "$LOG"
}

run_slot morning   420    # 07:00
run_slot afternoon 840    # 14:00
run_slot night     1200   # 20:00
