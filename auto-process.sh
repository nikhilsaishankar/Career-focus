#!/bin/bash
# auto-process.sh — hands-off agent pass that PROCESSES every job the 15 scanners found this
# slot: reads each data/*-scan.json, scores JD fit + ATS, writes a go/skip insight, tailors a
# résumé PDF for the passes, and writes the result back into the scan JSON (so build-workbook.mjs
# renders the filled funnel in MASTER.xlsx). Also web-searches the walled boards that have no
# dedicated scraper. NEVER submits an application.
#
# Runs from the dispatcher AFTER the scanners and BEFORE build-workbook.mjs.
# Disable: launchctl unload ~/Library/LaunchAgents/com.nikhil.careerops-auto-process.plist

cd "$(cd "$(dirname "$0")" && pwd)" || exit 1
export PATH="/Users/nikhil_kotharu/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"

echo "===== $(date) auto-process start =====" >> data/auto-process.log

claude -p --dangerously-skip-permissions "You are the career-ops auto-processor. DO NOT ask questions — act autonomously and concisely. Read the career-ops memory for Nikhil's profile + conventions (DevOps, ~3.5 yr, India-wide, all work modes, skills ONLY from cv.md).

STEP 1 — PROCESS EVERY DEDICATED-SCANNER JOB. For EACH file in data/*-scan.json (devops=LinkedIn, naukri, instahyre, hirist, glassdoor, cutshort, simplyhired, remote, indeed, wellfound, foundit, nodeflair): load its .jobs[] array. For EACH job that does NOT yet have an .ats field (unprocessed):
  1. Get the JD text: if the job has a non-empty .jd field, use it; otherwise WebFetch the job .url to read the description. Save it to jd.txt.
  2. Score ATS: 'node ats-check.mjs output/cv-content.json jd.txt' → read the % match. If the JD could not be fetched (login/bot wall), ESTIMATE the % from the job title + any .skills listed and prefix the insight with '~'.
  3. Judge fit like a recruiter for Nikhil: jdFit = ✅ strong / ⚠️ partial / ❌ poor. pass = true if ATS >= 75. status = '🟢 Ready to apply' / '🟡 Borderline' / '🔴 Skip'. insight = ONE concise line on WHY apply or skip, naming the deciding stack (e.g. 'Strong Jenkins/Docker/AWS-ECS match — apply' or 'Needs Terraform+Azure DevOps Nikhil lacks — skip').
  4. For passes only (ATS >= 75): build a JD-TAILORED résumé — 'node tailor-resume.mjs jd.txt output/cv-content.json output/tailored.json' (reorder/emphasis only, NEVER invent a skill not in cv.md), 'node build-resume.mjs output/tailored.json output/tailored.html', 'node generate-pdf.mjs output/tailored.html ~/Documents/profile/Nikhil_DevOps_<Company>.pdf'. Re-run tailor-resume.mjs PER job so every PDF is unique. Verify the apply link is LIVE before marking 🟢.
  5. WRITE THE RESULT BACK: 'node set-job-result.mjs <file> <job.id> jdFit=<✅|⚠️|❌> ats=<num> pass=<true|false> status=\"<status>\" insight=\"<one line>\" resume=\"<pdf path or omit>\"'.
  Process a sensible number per source (favor the freshest); do not loop forever.

STEP 2 — WALLED BOARDS WITH NO SCRAPER. Web-search \"DevOps Engineer\" \"India\" on the boards that have no dedicated scraper (Google for Jobs, iimjobs, Apna, Shine, TimesJobs, Expertia, Turing, Arc.dev, WelcomeToTheJungle, Crossover, Workatastartup, Talent.com, Jooble) plus dream companies (Deloitte/EY/JPMorgan/UST). DevOps family, 3-4 yr band, drop internships, verify LIVE, dedupe against data/websearch-scan-history.tsv. Append each new fitting role to data/websearch-scan.json in the SAME shape as the other scans ({scanned_at, source:\"websearch\", jobs:[{id,title,company,location,url}]}), then process those jobs exactly as in STEP 1 (jd → ATS → insight → resume-for-pass → set-job-result.mjs data/websearch-scan.json <id> ...). Create the file if missing.

HARD RULES: skills ONLY from cv.md — NEVER invent a stack; NEVER submit/apply (stop at the ready PDF + verified link); one generic cover letter at ~/Documents/profile/Nikhil-Cover-Letter.pdf is enough (no per-job cover letters unless asked). Keep it concise." >> data/auto-process.log 2>&1

echo "===== $(date) auto-process done =====" >> data/auto-process.log
