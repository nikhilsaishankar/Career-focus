# Career-Focus

> A multi-portal **DevOps job-search automation** that scans 15 job boards, scores every role against **your** résumé (ATS), tailors a résumé per job, and **auto-applies** to the matches — all rolled into a single master Excel workbook.

[![Node.js](https://img.shields.io/badge/Node.js-LTS-339933.svg?logo=node.js)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.47-2EAD33.svg?logo=playwright)](https://playwright.dev)
[![ExcelJS](https://img.shields.io/badge/ExcelJS-4.x-217346.svg?logo=microsoft-excel)](https://github.com/exceljs/exceljs)
[![Portals](https://img.shields.io/badge/Portals-15-blue.svg)](#the-15-portals)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [The 15 Portals](#the-15-portals)
- [Repository Structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [1. Install](#1-install)
  - [2. Add your résumé](#2-add-your-résumé)
  - [3. Add portal logins](#3-add-portal-logins)
  - [4. One-time browser logins](#4-one-time-browser-logins)
- [Usage](#usage)
  - [Scan the boards](#scan-the-boards)
  - [Score + tailor (the funnel)](#score--tailor-the-funnel)
  - [Build the master workbook](#build-the-master-workbook)
  - [Auto-apply to the matches](#auto-apply-to-the-matches)
- [The Master Workbook](#the-master-workbook)
- [Daily Automation](#daily-automation)
- [Command Reference](#command-reference)
- [Common Workflow](#common-workflow)
- [Ethics & Safety](#ethics--safety)

---

## Overview

Job hunting across a dozen portals is repetitive: search the same role on each board, open every JD, judge the fit, rewrite your résumé to match, then apply. **Career-Focus automates the whole loop.**

It runs in five stages:

| Stage | What happens |
|-------|--------------|
| **1. Scan** | 15 boards are searched for your target role (default: *"DevOps Engineer"*, India, below-4-yr). Each writes `data/<board>-scan.json`. |
| **2. Score** | Every job's JD is matched against your CV → an **ATS %**, a **fit verdict** (✅/⚠️/❌), and a one-line **go/skip insight**. |
| **3. Tailor** | For every passing job (ATS ≥ 75%), a **JD-tailored résumé PDF** is generated (reorder + emphasis only — never invents skills). |
| **4. Workbook** | Everything lands in one **`MASTER.xlsx`** — a tab per portal, color-coded funnel, clickable links. |
| **5. Apply** | An agent **auto-applies** to the green-shortlisted jobs on the portals you're logged into, and marks them applied on the sheet. |

The result: open **one spreadsheet**, see every DevOps role across 15 boards, scored and ranked, with ready-to-send résumés — and the good ones already applied to.

---

## Quick Start (New User)

Clone it, change **4 things**, run **4 commands**. That's it.

```bash
git clone https://github.com/nikhilsaishankar/Career-focus.git
cd Career-focus
npm install
npx playwright install chrome
```

### The only files YOU change

| # | File | Copy from | What to put |
|---|------|-----------|-------------|
| 1 | `cv.md` | `cv.example.md` | your résumé in markdown (the human-readable source) |
| 2 | `output/cv-content.json` | `output/cv-content.example.json` | your résumé as structured JSON — **this is what the ATS + tailoring read** |
| 3 | `~/.career-ops/credentials.json` | `config/credentials.example.json` | your logins for the gated boards (Naukri, Hirist, etc.) |
| 4 | `~/Downloads/H/CV-You.pdf` | — | your résumé **PDF** (what the apply agents upload) |

```bash
cp cv.example.md cv.md                                   # then edit with your details
cp output/cv-content.example.json output/cv-content.json # then edit with your details
mkdir -p ~/.career-ops && cp config/credentials.example.json ~/.career-ops/credentials.json
mkdir -p ~/Downloads/H        # drop your CV-<You>.pdf here
```

> **Optional:** change the target role/location. The default search is *"DevOps Engineer" · India · below-4-yr*. To target a different role, edit the `QUERY` / `JOBS_URL` and the `DEVOPS_TITLE` regex near the top of each `scan-*.mjs` (they're identical across scanners), or just ask an AI agent to do it for you.

### Then run it

**The one command** — scan all 15 boards → score → tailor → build the workbook → open it:

```bash
# first time only: log in once to the gated boards (a window opens, sign in, it saves)
node scan-naukri.mjs --login
node scan-hirist.mjs --login
node scan-instahyre.mjs --login
node scan-wellfound.mjs --login

# then, every time you want a fresh sweep:
bash run-all.sh          #  (or: npm run all)
```

That's it — `MASTER.xlsx` opens with every role across 15 boards, scored, with tailored résumés. Add a number to cap jobs per board: `bash run-all.sh 15`.

<details>
<summary>What <code>run-all.sh</code> runs under the hood (if you'd rather do it step by step)</summary>

```bash
# scan the boards (headless where possible, Glassdoor/Wellfound visible)
node scan-remote.mjs && node scan-simplyhired.mjs && node scan-foundit.mjs
node scan-devops.mjs && node scan-indeed.mjs --headless && node scan-cutshort.mjs --headless && node scan-nodeflair.mjs --headless
node scan-naukri.mjs --headless && node scan-hirist.mjs --headless && node scan-instahyre.mjs --headless && node scan-wellfound.mjs
node scan-glassdoor.mjs

node accumulate.mjs        # keep every portal's full set across runs (nothing disappears)
node process-scans.mjs     # ATS-score every job against YOUR cv + fill the funnel
node gen-pass-pdfs.mjs     # tailored résumé PDF per matching company
node build-workbook.mjs    # build the master workbook
open reports_stats/$(date +%F)/MASTER.xlsx
```
</details>

To **auto-apply** to the green matches on a portal:

```bash
node apply-hirist.mjs --dry    # safe preview (locates Apply, doesn't submit)
node apply-hirist.mjs          # apply to all green (ATS ≥ 75%) Hirist jobs
```

Everything below explains each piece in detail.

---

## How It Works

```
        ┌──────────────┐
        │  15 SCANNERS │   zero-token APIs + real-browser scrapers
        └──────┬───────┘
               ▼
        data/*-scan.json          (raw jobs: company, role, link, JD)
               │
               ▼
   ┌────────────────────────┐
   │  accumulate.mjs        │   merge into a durable pool — every portal keeps its full
   └───────────┬────────────┘   set across runs (scores + applied status preserved)
               ▼
   ┌────────────────────────┐
   │  process-scans.mjs     │   ATS score vs your CV → JD-fit + insight
   │  gen-pass-pdfs.mjs     │   tailored résumé PDF for ATS >= 75%
   └───────────┬────────────┘
               ▼
   ┌────────────────────────┐
   │  build-workbook.mjs    │   →  reports_stats/<date>/MASTER.xlsx
   └───────────┬────────────┘       (one tab per portal + Summary)
               ▼
   ┌────────────────────────┐
   │  apply-<portal>.mjs    │   auto-apply to the matches → mark Applied
   └────────────────────────┘
```

Each scanner is **dedup-aware** (a TSV history per board, never repeats a job) and writes a normalized job shape, so the downstream scoring and workbook treat every board identically.

---

## The 15 Portals

| # | Portal | How it's scanned | Login needed |
|---|--------|------------------|--------------|
| 1 | **LinkedIn** | guest jobs API | no |
| 2 | **Naukri** | real browser + your session | yes |
| 3 | **Instahyre** | real browser + your session | yes |
| 4 | **Hirist** | real browser + your session | yes |
| 5 | **Glassdoor** | real browser (public cards) | no\* |
| 6 | **Cutshort** | real browser (public SPA) | no |
| 7 | **SimplyHired** | zero-token HTTP | no |
| 8 | **Indeed** | real browser (homepage-first, beats Cloudflare) | no |
| 9 | **Foundit** (ex-Monster) | zero-token middleware API | no |
| 10 | **NodeFlair** | real browser (public SPA) | no |
| 11 | **Wellfound** (ex-AngelList) | real browser + your session | yes |
| 12 | **RemoteOK** | zero-token API | no |
| 13 | **Remotive** | zero-token API | no |
| 14 | **Himalayas** | zero-token API | no |
| 15 | **WeWorkRemotely** | zero-token RSS | no |

> \* Glassdoor serves public cards but **IP-blocks** aggressive automation — it runs visible (popup) and recovers on its own cadence.
>
> **Zero-token** = pure HTTP/API, no browser, no cost. **Real browser** = Playwright + Chrome with anti-detection flags. Boards needing login reuse a saved Chrome profile.

---

## Repository Structure

```
Career-focus/
├── scan-devops.mjs            # LinkedIn (guest API)
├── scan-naukri.mjs            # Naukri (browser + session)
├── scan-instahyre.mjs         # Instahyre (browser + session)
├── scan-hirist.mjs            # Hirist (browser + session)
├── scan-glassdoor.mjs         # Glassdoor (browser, public)
├── scan-cutshort.mjs          # Cutshort (browser, public SPA)
├── scan-simplyhired.mjs       # SimplyHired (zero-token HTTP)
├── scan-indeed.mjs            # Indeed (browser, homepage-first)
├── scan-foundit.mjs           # Foundit (zero-token API)
├── scan-nodeflair.mjs         # NodeFlair (browser, public SPA)
├── scan-wellfound.mjs         # Wellfound (browser + session)
├── scan-remote.mjs            # RemoteOK · Remotive · Himalayas · WWR (zero-token)
├── scan-stats.mjs             # location/region/source stats
│
├── process-scans.mjs          # ATS score + JD-fit + insight + résumé for passes
├── gen-pass-pdfs.mjs          # tailored résumé PDF per passing company
├── set-job-result.mjs         # write a processed result back into a scan JSON
├── ats-check.mjs              # keyword-coverage ATS gate (pass = 75%)
├── tailor-resume.mjs          # reorder + bold a résumé to a JD (no invention)
├── build-resume.mjs           # fill the HTML template from a content JSON
├── generate-pdf.mjs           # HTML → PDF (Playwright)
│
├── accumulate.mjs             # keep every portal's FULL job set across runs (nothing disappears)
├── build-workbook.mjs         # the ONE master workbook (tab per portal)
├── funnel-to-xlsx.mjs         # markdown funnel → colored xlsx (helper)
├── reports-paths.mjs          # date-wise output paths
│
├── apply-hirist.mjs           # auto-apply agent — Hirist
├── apply-instahyre.mjs        # auto-apply agent — Instahyre
│
├── run-all.sh                 # THE one command: scan all → score → tailor → workbook
├── scan-dispatcher.sh         # runs the whole loop each slot (3×/day)
├── auto-process.sh            # agent pass: fills no-JD jobs + walled boards
├── daily-devops.sh            # LinkedIn refresh helper
│
├── templates/cv-template.html # résumé template
├── config/profile.example.yml # your profile (copy → profile.yml)
├── config/credentials.example.json
├── cv.md                      # YOUR résumé (markdown source of truth)
└── output/cv-content.json     # YOUR résumé as structured JSON (used by ATS + tailoring)
```

Generated at runtime (gitignored): `data/*-scan.json`, `reports_stats/<date>/MASTER.xlsx`, tailored PDFs.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js** | LTS (18+). The scripts are ES modules (`.mjs`). |
| **Google Chrome** | Playwright drives your real Chrome (`channel: "chrome"`). |
| **macOS / Linux** | Built and tested on macOS; the dispatcher uses `launchd`/cron. |
| **Claude CLI** *(optional)* | Only for `auto-process.sh` (fills JDs that are bot-walled). The rest works without it. |

Verify:

```bash
node --version
google-chrome --version || echo "install Google Chrome"
```

---

## Setup

### 1. Install

```bash
git clone https://github.com/nikhilsaishankar/Career-focus.git
cd Career-focus
npm install
npx playwright install chrome
```

### 2. Add your résumé

This is the **most important step** — every ATS score and tailored résumé is built from *your* CV.

```bash
cp cv.example.md cv.md                                    # 1. your résumé in markdown
cp output/cv-content.example.json output/cv-content.json  # 2. your résumé as structured JSON
```

1. Edit **`cv.md`** (markdown: Summary, Experience, Projects, Skills).
2. Edit **`output/cv-content.json`** — this is what the ATS checker + tailoring actually read. Keep it accurate: only list skills you really have (they become your ATS keywords).
3. Drop your **PDF résumé** at `~/Downloads/H/CV-<You>.pdf` — the apply agents upload this (also update it on each portal account).

> `cv.md` and `output/cv-content.json` are **gitignored** — your real résumé never gets pushed. The `*.example` files are the templates you copy from.

### 3. Add portal logins

Real credentials live **outside the repo** (never committed) at `~/.career-ops/credentials.json`:

```bash
mkdir -p ~/.career-ops
cp config/credentials.example.json ~/.career-ops/credentials.json
# edit it with your real portal logins
```

### 4. One-time browser logins

Login-gated boards reuse a saved Chrome profile. Log in once per board (a window opens — sign in, solve any OTP/captcha, it saves the session):

```bash
node scan-naukri.mjs --login
node scan-hirist.mjs --login
node scan-instahyre.mjs --login
node scan-wellfound.mjs --login
```

The no-login boards (LinkedIn, SimplyHired, Foundit, Indeed, Cutshort, NodeFlair, RemoteOK, Remotive, Himalayas, WeWorkRemotely, Glassdoor) need nothing.

---

## Usage

### Scan the boards

Run any single board, or all of them:

```bash
# zero-token boards (no browser, instant)
node scan-remote.mjs          # RemoteOK + Remotive + Himalayas + WeWorkRemotely
node scan-simplyhired.mjs
node scan-foundit.mjs

# browser boards (no login)
node scan-indeed.mjs --headless
node scan-cutshort.mjs --headless
node scan-nodeflair.mjs --headless
node scan-glassdoor.mjs        # visible (Glassdoor blocks headless)

# browser boards (your session)
node scan-naukri.mjs --headless
node scan-hirist.mjs
node scan-instahyre.mjs
node scan-wellfound.mjs
```

Each writes `data/<board>-scan.json` and dedups against its history. Pass a number to cap results (e.g. `node scan-foundit.mjs 15`).

### Score + tailor (the funnel)

```bash
node process-scans.mjs      # ATS-score every job that has a JD, fill fit/insight/status
node gen-pass-pdfs.mjs      # tailored résumé PDF for each passing company (ATS >= 75%)
```

`process-scans.mjs` writes the verdict back into each scan JSON: **ATS %**, **JD-Fit** (✅/⚠️/❌), a **go/skip insight**, and a **status** (🟢 Ready / 🟡 Borderline / 🔴 Skip).

### Build the master workbook

```bash
node build-workbook.mjs
open reports_stats/$(date +%F)/MASTER.xlsx
```

### Auto-apply to the matches

The apply agents act on **only the green-shortlisted jobs** (ATS ≥ 75%) for a portal. Safe by design:

```bash
node apply-hirist.mjs --dry     # locate the Apply button, DON'T submit (proof run)
node apply-hirist.mjs --test    # apply to ONE shortlisted job (you watch)
node apply-hirist.mjs           # apply to all shortlisted Hirist jobs
```

- **One-click apply** → submits → marks **🟠 Applied (agent)** on the sheet.
- **Apply asks questions** → **does NOT submit** → captures the questions to `data/apply-questions.md` → marks **🟡 Basic details to fill**.
- **No shortlisted jobs** → does nothing. It never applies to anything you didn't shortlist.

---

## The Master Workbook

`reports_stats/<date>/MASTER.xlsx` — one file, **a tab per portal** + a **Summary** tab.

**Summary tab:** `Tier | Platform | New jobs | Last scan | State`
- **Tier 1** = LinkedIn, Naukri · **Tier 2** = dedicated scrapers · **Tier 3** = web-search · **Tier 4** = remote boards (last section).

**Each portal tab** is the funnel:

| Column | Meaning |
|--------|---------|
| Company — Role | the job |
| Location · Exp | where + experience band |
| **Link** | clickable JD / apply link |
| **JD Fit** | ✅ strong / ⚠️ partial / ❌ poor |
| **ATS** | % keyword coverage vs your CV |
| **Pass** | ✅ if ATS ≥ 75% |
| **Insight** | one-line *why apply / why skip* |
| **Résumé** | clickable tailored PDF (for passes) |
| **Status** | 🟢 Ready / 🟡 Borderline / 🔴 Skip |
| **Applied** | 🟠 Applied by agent · 🟡 Basic details to fill · blank |

At a glance: **🟢 + 🟠 = done by the agent**, **🟢 + 🟡 = your turn to fill the questions**.

---

## Daily Automation

`scan-dispatcher.sh` runs the full loop — scan → score → tailor → workbook — and is designed to fire **3×/day** (07:00, 14:00, 20:00) and **catch up** any slot missed while the machine was asleep.

**macOS (launchd):** point a `RunAtLoad` + `StartInterval=1800` agent at `scan-dispatcher.sh`.

**Linux (cron):**

```cron
0 7,14,20 * * *  /path/to/Career-focus/scan-dispatcher.sh
```

Browser scanners run **headless** (no popups) where they can; Glassdoor/Wellfound run visible because they block headless.

---

## Command Reference

| Command | Purpose |
|---------|---------|
| **`bash run-all.sh [N]`** | **the one command** — scan all 15 → score → tailor → workbook (cap N/board) |
| `npm run all` | alias for `run-all.sh` |
| `node accumulate.mjs` | keep every portal's full set across runs (run after scans/applies) |
| `node scan-<board>.mjs [N]` | scan one board, cap at N new jobs |
| `node scan-<board>.mjs --login` | one-time interactive login (gated boards) |
| `node scan-<board>.mjs --headless` | run a browser scanner with no window |
| `node scan-<board>.mjs --probe` | dump the rendered DOM (for selector tuning) |
| `node process-scans.mjs` | ATS-score + fill the funnel for all scanned jobs |
| `node gen-pass-pdfs.mjs` | tailored résumé PDF for each passing company |
| `node build-workbook.mjs` | (re)build the master workbook |
| `node scan-stats.mjs` | location / region / source breakdown |
| `node apply-<portal>.mjs --dry` | prove the apply target without submitting |
| `node apply-<portal>.mjs` | auto-apply to all shortlisted jobs on that portal |
| `bash scan-dispatcher.sh` | run the entire daily loop once |

---

## Common Workflow

```
1. Put your résumé in cv.md + output/cv-content.json
        │
        ▼
2. Log in once to the gated boards   →  node scan-<board>.mjs --login
        │
        ▼
3. Scan the boards                   →  node scan-*.mjs
        │
        ▼
4. Score + tailor                    →  node process-scans.mjs && node gen-pass-pdfs.mjs
        │
        ▼
5. Build the workbook                →  node build-workbook.mjs  →  open MASTER.xlsx
        │
        ▼
6. Auto-apply to the matches         →  node apply-<portal>.mjs
        │
        ▼
7. Fill the 🟡 (questions) ones yourself, then re-run
```

Or skip steps 3–5 and let `scan-dispatcher.sh` do them on a schedule.

---

## Ethics & Safety

- **Quality over quantity.** Only ATS ≥ 75% matches are shortlisted; the agent applies to *those* — never a blast.
- **Questions = stop.** If a portal asks screening questions, the agent **does not submit** — it captures them for you to answer.
- **Your résumé, your facts.** Tailoring is **reorder + emphasis only** — it never invents a skill that isn't already in your CV.
- **Credentials stay local.** Logins live in `~/.career-ops/credentials.json`, outside the repo and gitignored.

---

<div align="center">
  <sub>Scan 15 boards · score against <strong>your</strong> CV · tailor résumés · auto-apply — in one workbook.</sub>
</div>
