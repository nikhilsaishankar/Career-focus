#!/bin/bash
# daily-devops.sh — auto-run the DevOps scan once a day.
# Wired to launchd (com.nikhil.careerops-devops-scan). You can also run it by hand.
# It scans LinkedIn (last 24h, "DevOps Engineer", Hyderabad, 3-4 yr band),
# dedups against history (never miss / never repeat), and sends a macOS notification.

cd "$(cd "$(dirname "$0")" && pwd)" || exit 1
export PATH="/opt/homebrew/bin:$PATH"

echo "===== $(date) =====" >> data/devops-scan.log
/opt/homebrew/bin/node scan-devops.mjs 10 >> data/devops-scan.log 2>&1
