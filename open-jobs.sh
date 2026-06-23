#!/bin/bash
# open-jobs.sh
# Opens LinkedIn + Naukri with EXACT filters for fresh DevOps roles.
#   - Phrase: "DevOps Engineer"  (double quotes are MANDATORY -> exact match)
#     Search is case-insensitive, so this also matches "Devops Engineer".
#   - Posted in the last 24 hours
#   - Location: Hyderabad
#   - Sorted by most recent
#
# Usage: bash open-jobs.sh

echo "🚀 Opening LinkedIn + Naukri for \"DevOps Engineer\" (last 24h, Hyderabad)..."

# ── 1. Naukri ──
# "DevOps Engineer" exact phrase, Hyderabad, jobAge=1 (last 24h), sorted by date
NAUKRI='https://www.naukri.com/devops-engineer-jobs-in-hyderabad?keyword=%22DevOps%20Engineer%22&jobAge=1&sort=date&location=Hyderabad'

# ── 2. LinkedIn ──
# "DevOps Engineer" exact phrase, Hyderabad, f_TPR=r86400 (last 24h), most recent first
LINKEDIN='https://www.linkedin.com/jobs/search/?keywords=%22DevOps%20Engineer%22&location=Hyderabad%2C%20Telangana%2C%20India&f_TPR=r86400&sortBy=DD'

open "$NAUKRI"
sleep 1
open "$LINKEDIN"

echo ""
echo "✅ Opened 2 portals (last 24h, exact \"DevOps Engineer\"):"
echo "   1. Naukri    — https://www.naukri.com"
echo "   2. LinkedIn  — https://www.linkedin.com"
echo ""
echo "👉 Copy up to 10 good job URLs, then in career-ops run:"
echo "   evaluate these jobs: <paste up to 10 URLs>"
echo "   (I score each vs your CV and build a tailored resume for the strong ones)"
