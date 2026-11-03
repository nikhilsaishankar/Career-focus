#!/bin/bash
# scripts/pipelines/daily-devops.sh — auto-run the DevOps scan once a day.
# Wired to launchd (com.nikhil.careerops-devops-scan). You can also run it by hand.
# It scans LinkedIn (last 24h, "DevOps Engineer", Hyderabad, 3-4 yr band),
# dedups against history (never miss / never repeat), and sends a macOS notification.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"   # repo root, wherever this is cloned
cd "$REPO" || exit 1
export PATH="/opt/homebrew/bin:$PATH"

echo "===== $(date) =====" >> data/devops-scan.log
# No job cap: the 24h window is the filter. Capping silently discarded qualifying jobs.
/opt/homebrew/bin/node scripts/scan/scan-devops.mjs >> data/devops-scan.log 2>&1
