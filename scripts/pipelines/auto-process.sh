#!/bin/bash
# scripts/pipelines/auto-process.sh — hands-off agent pass that PROCESSES every job the 15 scanners found this
# slot: reads each data/*-scan.json, scores JD fit + ATS, writes a go/skip insight, resolves each
# job's direct company-careers link (replacing the raw portal link), and writes the result back
# into the scan JSON (so scripts/sheets/build-workbook.mjs renders the filled funnel in MASTER.xlsx).
# Also web-searches the walled boards that have no dedicated scraper. NEVER submits an application.
# Résumé PDFs: OFF since 2026-10-14 (per Nikhil: "no need company wise folder — i need only
# sheet hyderabad and naukri sheet under date wise folder"). The gen-pass-pdfs.mjs step is
# commented out in every pipeline; nothing writes ~/main/profile/<date>/<Company>/ any more.
# Manual /jd résumés still go to ~/main/profile/manual/<Company>/.
#
# Runs from the dispatcher AFTER the scanners and BEFORE scripts/sheets/build-workbook.mjs.
# Disable: launchctl unload ~/Library/LaunchAgents/com.nikhil.careerops-auto-process.plist

REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"   # repo root, wherever this is cloned
cd "$REPO" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"

# Single-flight lock (added 2026-08-14, hyderabad-openings.sh/naukri-refresh-strict.sh pattern):
# STEP 1B now does real WebSearch/WebFetch link resolution, so a run can take 10-15+ min —
# long enough for the dispatcher's own hyd catch-up chain AND a manual invocation to overlap
# and race-write the same data/*-scan.json files. Stale lock (>25 min) is taken over.
LOCK="/tmp/careerops-auto-process.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -lt 1500 ]; then
    echo "===== $(date) auto-process SKIPPED — another run already in progress (lock ${age}s old) =====" >> data/auto-process.log
    exit 0
  fi
  echo "===== $(date) auto-process: stale lock (${age}s) — taking over =====" >> data/auto-process.log
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 1
fi
trap 'rm -rf "$LOCK"' EXIT

echo "===== $(date) auto-process start =====" >> data/auto-process.log

claude -p --dangerously-skip-permissions "You are the career-ops auto-processor. DO NOT ask questions — act autonomously and concisely. Read the career-ops memory for Nikhil's profile + conventions (DevOps, ~3.5 yr, India-wide, all work modes, skills ONLY from cv.md).

STEP 1 — PROCESS EVERY DEDICATED-SCANNER JOB. For EACH file in data/*-scan.json (devops=LinkedIn, naukri, google=Google jobs tab, instahyre, hirist, glassdoor, cutshort, simplyhired, remote, indeed, wellfound, foundit, nodeflair): load its .jobs[] array. For EACH job that does NOT yet have an .ats field (unprocessed — note: most jobs get scored by the earlier deterministic process-scans.mjs pass before you ever see them, so this step usually only catches the ones with no JD text/skills to score from):
  1. Get the JD text: if the job has a non-empty .jd field, use it; otherwise WebFetch the job .url to read the description. Save it to jd.txt. SPECIAL CASE google-scan.json: its .url is often a google.com share link that WebFetch cannot read — instead WebSearch '<company> <title> hyderabad site:<via board>' (the job's .via field names the board: Shine/BeBee/LinkedIn/etc.) to find the JD.
  2. Score ATS: 'node scripts/resume/ats-check.mjs output/cv-content.json jd.txt' → read the % match. If the JD could not be fetched (login/bot wall), ESTIMATE the % from the job title + any .skills listed and prefix the insight with '~'.
  3. GATE CHECK (MANDATORY, do not skip): ATS score alone is NEVER enough — a JD can mention AWS/Kubernetes and still be the wrong role (e.g. a Go Lang software-engineering seat, an Azure-only role, VMware/mainframe ops). Run 'node scripts/lib/check-gate.mjs <file> <job.id>' — this is the SAME gate the HYDERABAD sheet and /jd use (job-filters.mjs sheetAdmits), and it is the authority, not your own judgment. It prints PASS (exit 0) or REJECT: <reason> (exit 1). pass = true ONLY if ATS >= 75 AND check-gate.mjs printed PASS. If check-gate.mjs prints REJECT, pass = false regardless of ATS score, and the insight MUST include its stated reason. jdFit = ✅ strong / ⚠️ partial / ❌ poor. status = '🟢 Ready to apply' / '🟡 Borderline' / '🔴 Skip'. insight = ONE concise line naming the deciding stack or the check-gate.mjs rejection reason (e.g. 'Strong Jenkins/Docker/AWS-ECS match — apply' or 'REJECT: wrong-core stack (Go Lang) — skip despite 80% ATS').
  4. WRITE THE RESULT BACK: 'node scripts/apply/set-job-result.mjs <file> <job.id> jdFit=<✅|⚠️|❌> ats=<num> pass=<true|false> status=\"<status>\" insight=\"<one line>\"'. Do NOT pass a resume= value — tailored résumé generation is OFF (per Nikhil 2026-10-14: sheets only, no per-company folders). Leave the résumé field empty.
  Process a sensible number per source (favor the freshest); do not loop forever.

STEP 1B — RESOLVE COMPANY-CAREERS LINKS (MANDATORY, runs INDEPENDENTLY of STEP 1's ats gate — per user 2026-08-14: replace the raw portal link with the employer's own posting, for every job, every source, not just the ones STEP 1 happens to touch). For EACH file in data/*-scan.json: for jobs where '.linkResolved' is not true (check this regardless of whether .ats/.pass is already set — scoring and link-resolution are separate passes), pick the FRESHEST/most-recently-discovered ones first and process up to ~15 per source this run (this drains a backlog over multiple runs, not a one-shot — do not try to do all of them at once). For each: WebSearch '<company> careers <title>' (or '<company> jobs <title>'), open the top company-domain result, and WebFetch it to CONFIRM it is LIVE (title + JD + an Apply control; a 404/closed/redirect-to-search page does not count). Write back via 'node scripts/apply/set-job-result.mjs <file> <job.id> linkResolved=true' PLUS 'url=\"<resolved company-careers link>\"' if a live one was found — if nothing live turns up after a reasonable search, still set linkResolved=true (so it isn't retried every run) and leave the original portal url untouched; never hand back a dead or unverified link. Do this for 🔴 Skip / 🟡 Borderline rows too, not just 🟢 passes — Nikhil reads the sheet link before the score.

STEP 2 — WALLED BOARDS WITH NO SCRAPER. Web-search \"DevOps Engineer\" \"India\" on the boards that have no dedicated scraper (Google for Jobs, iimjobs, Apna, Shine, TimesJobs, Expertia, Turing, Arc.dev, WelcomeToTheJungle, Crossover, Workatastartup, Talent.com, Jooble) plus dream companies (Deloitte/EY/JPMorgan/UST). DevOps family, required experience ≤4 yrs (keep any role whose floor is ≤4, drop 5+ floors — per user 2026-07-17), drop internships, verify LIVE, dedupe against data/websearch-scan-history.tsv (STRICT format, 4 tab-separated columns, NO header: id\\tYYYY-MM-DD\\tcompany\\ttitle — column 2 MUST be the ISO date you first saw the job; any other column order silently breaks the 24h sheet filter). Append each new fitting role to data/websearch-scan.json in the SAME shape as the other scans ({scanned_at, jobs:[{id,title,company,location,url,source,discovered_via}]}). Per job: 'source' = the board the URL actually lands on (Talent.com / Apna / Greenhouse / Deloitte / LinkedIn / ...); 'discovered_via' = the channel you found it through, EXACTLY \"google\" when it came from Google for Jobs, otherwise the board name lowercased. The Google workbook tab keys off discovered_via, so never guess it — omit the job rather than mislabel it, then process those jobs exactly as in STEP 1+1B (jd → ATS → insight → scripts/apply/set-job-result.mjs data/websearch-scan.json <id> ..., then resolve its company-careers link the same way). Create the file if missing.

HARD RULES: skills ONLY from cv.md — NEVER invent a stack; NEVER submit/apply (stop at the verified link — this is scan/score/notify, not apply); NEVER write a cover letter in this pass (still build one only when Nikhil explicitly asks — /jd or the resume-tailor agent). Keep it concise." >> data/auto-process.log 2>&1

echo "===== $(date) auto-process done =====" >> data/auto-process.log
