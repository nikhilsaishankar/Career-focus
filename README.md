# Career-Focus

> Multi-portal **DevOps job-search automation**: sweep the boards, put every role through a
> strict fit gate, score what survives against **your** résumé, and roll the result into
> date-wise Excel sheets you can open and act on.

[![Node.js](https://img.shields.io/badge/Node.js-LTS-339933.svg?logo=node.js)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.58-2EAD33.svg?logo=playwright)](https://playwright.dev)
[![ExcelJS](https://img.shields.io/badge/ExcelJS-4.x-217346.svg?logo=microsoft-excel)](https://github.com/exceljs/exceljs)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Table of Contents

- [What changed in v5](#what-changed-in-v5)
- [Overview](#overview)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [The Fit Gate](#the-fit-gate)
- [Boards & Sweeps](#boards--sweeps)
- [Repository Structure](#repository-structure)
- [Setup](#setup)
- [Usage](#usage)
- [Daily Automation](#daily-automation)
- [Command Reference](#command-reference)
- [Ethics & Safety](#ethics--safety)

---

## What changed in v5

v1 was 15 flat scanners at the repo root and one master workbook. Five rounds of real use
later, the shape is different:

| | v1 | v5 |
|---|---|---|
| **Layout** | ~30 `.mjs`/`.sh` at the repo root | `scripts/{scan,apply,resume,sheets,naukri,lib,pipelines}/` |
| **Boards** | 15 scanned, most of them thin | **6 scanned properly** + company-careers sweeps for the rest |
| **Filtering** | ATS % only (`pass = ATS >= 75`) | a **real fit gate** (`scripts/lib/job-filters.mjs`) that runs before scoring |
| **Coverage** | one search phrase per board | **multi-query family sweep** — DevOps / SRE / Platform / Cloud, because a posting titled "Site Reliability Engineer" never shows up on a "DevOps Engineer" search |
| **Durability** | each run overwrote its scan JSON | `accumulate.mjs` keeps a durable pool — nothing a run dropped disappears |
| **Dedup** | per run | cross-day ledger, so a sheet shows **new-today only** |
| **Output** | `MASTER.xlsx` | `reports_stats/<date>/HYDERABAD.xlsx` + `TRACKER.xlsx` |
| **Scheduling** | plain launchd calendar jobs | a dispatcher that **replays slots missed** while the Mac slept, plus wake scheduling |
| **Identity** | name/email/phone hardcoded in scripts | all of it in `config/profile.json` (git-ignored) |

Why a gate and not just an ATS score: an ATS percentage says *how well your résumé matches
the words in the JD*. It says nothing about whether the role demands 8 years, is really an
Azure job, or is an application-support seat wearing a DevOps title. Those are rejections,
not low scores, and they belong **before** scoring — otherwise they fill the sheet.

---

## Overview

Job hunting across a dozen portals is repetitive: run the same search on each board, open
every JD, work out whether it's actually in band, judge the fit, then apply. Career-Focus
automates that loop and leaves you with a spreadsheet instead of forty browser tabs.

| Stage | What happens |
|-------|--------------|
| **1. Sweep** | Six boards searched across the whole DevOps title family. Each writes `data/<board>-scan.json`. |
| **2. Accumulate** | Every run merges into a durable pool, so a board that walls you one afternoon doesn't erase what it gave you that morning. |
| **3. Gate** | `sheetAdmits()` decides admission: experience floor, cloud, core stack, title, employer, seniority grade. Rejections are logged with a reason. |
| **4. Score** | Survivors get an **ATS %**, a **fit verdict** (✅/⚠️/❌) and a one-line go/skip insight. |
| **5. Resolve** | Portal links are replaced with the employer's own live posting where one can be verified. |
| **6. Sheet** | `reports_stats/<date>/HYDERABAD.xlsx` (new-today, colour-coded, clickable) + `TRACKER.xlsx`. |

---

## Quick Start

```bash
git clone https://github.com/nikhilsaishankar/Career-focus.git
cd Career-focus
npm install
npx playwright install chrome

cp config/profile.example.json config/profile.json   # your name / email / phone / paths
mkdir -p ~/.career-ops
cp config/credentials.example.json ~/.career-ops/credentials.json   # portal logins (outside the repo)

npm run all        # scan → gate → score → sheets
```

Three files are yours to fill in, and none of them is tracked by git:

| File | Holds |
|------|-------|
| `config/profile.json` | name, email, phone, profile folder, résumé path |
| `~/.career-ops/credentials.json` | portal logins — deliberately **outside** the repo |
| `cv.md` + `output/cv-content.json` | your résumé, prose and structured (see `cv.example.md`, `output/cv-content.example.json`) |

---

## How It Works

```
 boards ──► scan/scan-*.mjs ──► data/<board>-scan.json
                                      │
                       scan/accumulate.mjs ──► durable pool (survives every run)
                                      │
                   lib/job-filters.mjs  ◄── the gate; rejects get an audited reason
                                      │
                 scan/process-scans.mjs ──► ATS % + fit verdict + insight
                                      │
              pipelines/auto-process.sh ──► fills gaps, resolves links to live postings
                                      │
            sheets/build-hyderabad-sheet.mjs ──► reports_stats/<date>/HYDERABAD.xlsx
                 sheets/build-tracker.mjs   ──► reports_stats/<date>/TRACKER.xlsx
```

Two rules hold the whole thing together:

1. **One gate, one definition of fit.** The sheet builder, the agent pass and the manual
   `/jd` path all call the same `sheetAdmits()`. `scripts/lib/check-gate.mjs` exposes it to
   the shell so an agent never has to re-judge the gate in prose — that is exactly how
   "pass = ATS ≥ 75" drift crept in once, and the gate is now the single answer.
2. **Never lose a job.** Scanners overwrite their JSON on every run, so `accumulate.mjs`
   runs after each one and the pool keeps the union.

---

## The Fit Gate

`scripts/lib/job-filters.mjs` is the opinionated part of this repo — tuned against real
rejections, with the reason written down next to each rule.

| Check | Rejects |
|-------|---------|
| `expFloor` / `bodyExpFloor` | roles whose experience floor is above the band. **The JD body outranks the portal's header band** — a board advertised "4-8 yrs" while the JD itself said "Experience: 5-7 Years". |
| `tooSenior` / `isOutOfBandGrade` | Lead / Staff / Principal / Manager grades |
| `isAzureJob` / `isGcpJob` | roles centred on a cloud that isn't yours |
| `isWrongCore` / `isWrongPlatformTitle` / `wrongPlatformMustHave` | postings whose core stack is a different discipline wearing a DevOps title |
| `isSupportRole` / `isAppSupportCore` | application-support seats |
| `isSuspectEmployer` | known bait listings |
| `dupKey` | the same posting arriving from two boards |

Every check **fails open when the signal is genuinely absent** — a job with no parsable
experience text is kept, because missing a real opening costs more than one extra row. But
any floor that *is* parsable and out of band is rejected. Each rejection lands in
`data/skip-audit.tsv` with its reason, so the gate stays auditable rather than mysterious.

---

## Boards & Sweeps

**Scanned properly** — LinkedIn (24h window), Naukri, Google jobs tab, Indeed India, Hirist,
Instahyre. Headless by default; Indeed runs real Chrome because Cloudflare walls anything
less. A board walling you never stops the rest of the run.

**Company-careers sweeps** resolve a portal link to the employer's own posting and confirm
it's live: Salesforce, Workday-hosted, Weekday, BuiltIn mirrors, Shine, JobFound,
JoinDevOps, plus slug discovery. Also present and runnable: Cutshort, Wellfound, Apple,
Talent, Apna/Shine.

v1 scanned 15 boards. Six of them produced almost nothing real (remote aggregators,
SimplyHired, Foundit, NodeFlair), so they were dropped in favour of making the six that
work actually thorough.

---

## Repository Structure

```
Career-focus/
├── scripts/
│   ├── scan/        portal scanners, careers sweeps, ATS probes, post-processing
│   ├── lib/         the fit gate, check-gate CLI, identity, report paths, ledgers
│   ├── sheets/      HYDERABAD.xlsx + TRACKER.xlsx builders
│   ├── resume/      tailor / build (HTML + docx) / ATS check / cover letter
│   ├── apply/       apply assistants + result write-back
│   ├── naukri/      profile freshness + keyword helpers
│   └── pipelines/   the .sh orchestrators and launchd entrypoints
├── config/          profile + credentials examples (your real ones are git-ignored)
├── templates/       cv-template.html
├── output/          generated résumé content (example committed, rest ignored)
├── data/            scan JSON, logs, ledgers — entirely git-ignored
└── generate-pdf.mjs HTML → PDF renderer
```

Each folder has its own README with a file-by-file table.

---

## Setup

**Prerequisites:** Node.js LTS, Chrome (via `npx playwright install chrome`), macOS if you
want the launchd scheduling (everything else is platform-neutral).

```bash
npm install
npx playwright install chrome
```

**1. Your identity** — `cp config/profile.example.json config/profile.json`, then fill in
`fullName`, `email`, `phone`, `profileDir`, `resumePath`. Every script reads these through
`scripts/lib/identity.mjs`; nothing is hardcoded.

**2. Your résumé** — write `cv.md` (see `cv.example.md`) and
`output/cv-content.json` (see `output/cv-content.example.json`). The structured JSON is what
tailoring and ATS scoring read.

**3. Portal logins** — `cp config/credentials.example.json ~/.career-ops/credentials.json`
and fill in. It lives outside the repo so it can never be committed by accident.

**4. One-time browser logins** — the gated boards keep a saved Chrome profile under
`~/.career-ops/<board>-chrome-profile/`:

```bash
node scripts/scan/scan-naukri.mjs --login
node scripts/scan/scan-hirist.mjs --login
node scripts/scan/scan-instahyre.mjs --login
node scripts/scan/scan-indeed.mjs --login
```

A window opens, you sign in (OTP, captcha, whatever the board asks), and the session is
reused headlessly from then on.

---

## Usage

```bash
# everything, in order
npm run all                 # or: bash scripts/pipelines/run-all.sh
npm run all 15              # cap new jobs per board

# one board at a time
npm run scan:linkedin
npm run scan:naukri
npm run scan:google
npm run scan:indeed
npm run scan:hirist
npm run scan:instahyre

# the strict Hyderabad pipeline (multi-query family sweep, locked, audited)
npm run hyderabad

# pipeline pieces
npm run accumulate          # merge this run into the durable pool
npm run process             # ATS + fit scoring
npm run sheet               # HYDERABAD.xlsx
npm run tracker             # TRACKER.xlsx
npm run stats               # funnel stats

# ask the gate about one job
npm run gate -- data/naukri-scan.json <job-id>

# résumé + letter
npm run ats -- output/cv-content.json jd.txt
npm run cover-letter -- "Acme" "DevOps Engineer"
npm run resume:docx
```

Output lands in `reports_stats/<YYYY-MM-DD>/`: **HYDERABAD.xlsx** (every role that cleared
the gate, new today, colour-coded with live links) and **TRACKER.xlsx** (applied vs ready to
apply). Both are git-ignored — they're your data, not the project's.

---

## Daily Automation

macOS launchd does **not** replay a calendar job that was missed while the Mac was asleep or
powered off, which in v1 meant a closed laptop at 07:00 lost the morning scan for good. v5
fixes that:

| Piece | What it does |
|-------|--------------|
| `scan-dispatcher.sh` | Runs every 30 min and at login/wake. For any slot (07:00 / 14:00 / 20:00) that has passed and not yet run today, it runs the batch and drops a marker so it can't double-run. |
| `hyderabad-openings.sh` | The 03:00 / 08:00 / 18:00 / 20:00 Hyderabad slots — single-flight lock, up to 2 attempts 5 min apart, every attempt written to `data/hyderabad-audit.log`. |
| `night-awake.sh` | Keeps the Mac awake through the overnight window so the slots can fire. |
| `schedule-wakes.sh` | Registers `pmset` wake events ~2 min ahead of each slot. Needs root; `DRYRUN=1` to preview. (It can't power on a Mac that's shut down — Apple Silicon won't schedule that.) |

Wire it up by copying `scripts/pipelines/com.careerops-wake-scheduler.plist.example` into
`~/Library/LaunchAgents/` (or `/Library/LaunchDaemons/` for the wake scheduler), replacing
`__CAREER_OPS_REPO__` with your clone path, and `launchctl load`-ing it.

---

## Command Reference

| Command | Does |
|---------|------|
| `npm run all [cap]` | Full run: 6 boards → accumulate → gate + score → sheets |
| `npm run hyderabad` | Strict Hyderabad pipeline with the family sweep |
| `npm run apply` | Walk the jobs that cleared the gate, board by board |
| `npm run scan:<board>` | A single board (`linkedin`/`naukri`/`google`/`indeed`/`hirist`/`instahyre`) |
| `npm run accumulate` | Merge the latest scans into the durable pool |
| `npm run process` | ATS + fit scoring and write-back |
| `npm run sheet` / `tracker` | Build HYDERABAD.xlsx / TRACKER.xlsx |
| `npm run gate -- <file> <id>` | Ask the gate about one job (`PASS` / `REJECT: reason`) |
| `npm run ats -- <cv.json> <jd.txt>` | ATS % for a CV against a JD |
| `npm run cover-letter -- "<Company>" "<Role>"` | Cover letter, `.txt` + `.pdf` |
| `npm run resume:docx` | Résumé as `.docx` |
| `npm run naukri:refresh` | Re-upload the résumé to refresh Naukri profile freshness |
| `npm run stats` | Funnel stats for the latest run |
| `npm run pdf -- <in.html> <out.pdf>` | Render HTML to PDF |

---

## Ethics & Safety

- **Nothing is submitted without you.** The apply scripts stop at a prepared, verified
  application — they never click submit on your behalf.
- **No invented skills.** `tailor-resume.mjs` reorders and re-emphasises what's already in
  your CV content. It cannot add a stack you don't have, by design.
- **Your data stays yours.** `data/`, `reports_stats/`, `cv.md`, résumé PDFs and
  `config/profile.json` are all git-ignored; credentials live outside the repo in
  `~/.career-ops/`. Nothing in the tracked tree contains a real name, email, phone or login.
- **Respect the boards.** Scanners drive a real browser at human pace and read public
  listings. Keep the scheduling sane, don't hammer a board, and honour its terms.
- **Rate limits are a signal, not an obstacle.** If a board walls a run, the pipeline logs
  it and moves on. Don't work around a block — scan less often instead.

---

MIT © Nikhil Sai Shankar
