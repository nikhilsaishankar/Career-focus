#!/usr/bin/env node
// scan-google.mjs — scan the GOOGLE JOBS tab (search → Jobs vertical, udm=8) for fresh
// "DevOps Engineer" roles in Hyderabad via a REAL browser.
//
// Google's jobs vertical is a JS-rendered SPA: plain fetch gets an empty shell, and
// headless automation trips the "unusual traffic" captcha. So this drives a genuine
// Chrome (channel:chrome) with a persistent profile at ~/.career-ops/google-chrome-profile
// — same recipe as scan-indeed.mjs.
//
//   node scan-google.mjs [maxJobs]      # daily scan (default 25 new jobs max)
//   node scan-google.mjs --probe [url]  # dump DOM+screenshot for selector building
//   --headless hides the window (Google may captcha-wall headless; visible is safer)
//   --q="..." --loc="..."               # override query/location
//
// Filter: DevOps family · Hyderabad · required experience ≤ 4 yrs (floor-5+ dropped) ·
// strict last-24h (posted text must read minutes/hours-ago or "today" — no compromise).
// Output: data/google-scan.{json,md} + module15-Google md/xlsx, dedup via
// data/google-scan-history.tsv (picked up automatically by the seen-ledger).

import { chromium } from "playwright";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "../lib/reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(homedir(), ".career-ops", "google-chrome-profile");
const HISTORY = "data/google-scan-history.tsv";
const RP = reportPaths();
const MOD = RP.mod(1, "module15-Google");
const STATUS = MOD.md("module15-Google.md");
const XLSX_OUT = MOD.xlsx("module15-Google.xlsx");
const JSON_OUT = MOD.json("module15-Google.json");

const args = process.argv.slice(2);
const PROBE_MODE = args.includes("--probe");
// Headless is the DEFAULT (Nikhil 2026-10-26: "headless true only"). Pass --headed
// to watch a run; --headless is still accepted so existing callers keep working.
const HEADLESS = !args.includes("--headed");
const positional = args.filter((a) => !a.startsWith("--"));
// Default cap 60: the Hyderabad jobs tab serves ~60 cards per sweep and NOTHING below
// 4 yrs may be missed (per user 2026-07-17), so one run must be able to take them all.
const MAX = parseInt(positional.find((a) => /^\d+$/.test(a)) || "60", 10);
const QUERY = (args.find((a) => a.startsWith("--q=")) || "").slice(4) || '"devops engineer" jobs in hyderabad';
const JOBS_URL = `https://www.google.com/search?q=${encodeURIComponent(QUERY)}&udm=8&hl=en&gl=in`;
const PROBE_URL = positional.find((a) => a.startsWith("http")) || JOBS_URL;

const DEVOPS_TITLE =
  /dev[\s-]?(sec[\s-]?)?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release|kubernetes|\bk8s\b/i;

const EXP_MAX = 4; // keep any role requiring ≤4 yrs — drop only floor-5+ (per user 2026-07-17)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseExp(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  let lo = null, hi = null, m;
  for (const mm of t.matchAll(/(\d{1,2})\s*(?:-|to|–)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?|yoe)/g)) { lo = lo === null ? +mm[1] : Math.min(lo, +mm[1]); hi = hi === null ? +mm[2] : Math.max(hi, +mm[2]); }
  if (lo === null && (m = t.match(/(\d{1,2})\s*\+\s*(?:years?|yrs?|yoe)/))) lo = +m[1];
  if (lo === null && (m = t.match(/(\d{1,2})\s*(?:years?|yrs?|yoe)/))) { lo = +m[1]; hi = +m[1]; }
  if (lo === null && hi === null) return null;
  return { lo: lo ?? hi, hi: hi ?? lo };
}
function fitsBand(exp) {
  if (!exp) return { fit: true, reason: "exp unknown (kept)" };
  if (exp.lo > EXP_MAX) return { fit: false, reason: `${exp.lo}+ yrs (above 4)` };
  return { fit: true, reason: `${exp.lo}-${exp.hi ?? exp.lo} yrs (≤4 ok)` };
}

// Strict 24h freshness gate (per user 2026-08-17 "no compromise" audit — matches the
// f_TPR=r86400 LinkedIn window and Naukri/Indeed --days=1). Google's jobs-vertical
// cards only ever carry a relative "posted" fragment ("2 hours ago", "today", "3 days
// ago", "yesterday") — never an absolute timestamp — so this is exact, not a guess.
// Unknown/missing posted text is DROPPED, not kept: "no compromise" means unverified
// age doesn't get the benefit of the doubt.
function isFresh24h(posted) {
  if (!posted) return false;
  const p = posted.toLowerCase().trim();
  if (/^(just now|today)$/.test(p)) return true;
  const m = p.match(/^(\d+)\s*(minute|hour|day|week|month)s?\s*ago$/);
  if (!m) return false; // "yesterday" and anything unrecognized falls here
  return m[2] === "minute" || m[2] === "hour";
}

function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

// Google "unusual traffic" / captcha wall detection.
async function isChallenged() {
  try {
    const body = (await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 500) : ""))).toLowerCase();
    return /unusual traffic|not a robot|recaptcha|systems have detected/.test(body);
  } catch { return false; }
}

// Scrape the jobs-vertical list cards. Google rotates class names, so this works
// structurally: every job card in udm=8 is an <a> (or contains one) whose innerText is a
// multi-line block "Title \n Company \n Location \n via X ...". We collect candidate blocks
// from several generations of selectors, then fall back to a generic role=listitem walk.
// NOTE: the card-selector chain below is duplicated inside scrapeCards and clickCard
// (page.evaluate can't share host-side functions, and Google's CSP blocks eval).
// Same query order in both ⇒ stable card indexes between scrape and click.

async function scrapeCards() {
  return page.evaluate(() => {
    const getCards = () => {
      let cards = document.querySelectorAll("div.EimVGf, li.iFjolb, div.PwjeAc, [jsname='XKSfm'] li");
      if (!cards.length) cards = document.querySelectorAll("div[jscontroller][data-share-url]");
      if (!cards.length) {
        const main = document.querySelector("div[role='main']") || document.body;
        cards = main.querySelectorAll("[role='listitem'], a[jsname]");
      }
      return [...cards];
    };
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const out = [];
    const seen = new Set();
    const push = (el, idx) => {
      const txt = (el.innerText || "").trim();
      if (!txt || txt.length < 10) return;
      // Split into fragments: card lines, then each line on "•" (Google joins
      // "Hyderabad, Telangana • via LinkedIn" on one line). Drop logo-letter fragments.
      const rawLines = txt.split("\n").map((l) => l.trim()).filter(Boolean);
      // Some cards lead with a 1-2 char logo-letter line — skip to the first real line.
      while (rawLines.length && rawLines[0].length <= 3) rawLines.shift();
      if (rawLines.length < 2) return;
      const title = clean(rawLines[0]);
      if (!title || title.length > 140) return;
      const frags = [];
      for (const l of rawLines.slice(1, 10)) for (const f of l.split("•")) { const c = clean(f); if (c.length > 2) frags.push(c); }
      let company = "", location = "", via = "", posted = "", salary = "", jobType = "";
      for (const f of frags) {
        if (/^via /i.test(f)) { if (!via) via = clean(f.replace(/^via /i, "")); }
        else if (/\bago$|^today$|^yesterday$/i.test(f)) posted = f;
        else if (/₹|lakh|crore|a year|a month|an hour/i.test(f)) salary = f;
        else if (/^full[- ]?time$|^part[- ]?time$|^contract|^intern|^temporary$/i.test(f)) jobType = f;
        else if (!company) company = f;
        else if (!location) location = f;
      }
      const id = `${company}|${title}`.toLowerCase();
      if (!company || seen.has(id)) return;
      seen.add(id);
      // Per-job detail URL (ibp=htl;jobs + htidocid) — carries the JD + apply links.
      const shareEl = el.closest("[data-share-url]") || el.querySelector("[data-share-url]") || el;
      const shareUrl = shareEl.getAttribute && shareEl.getAttribute("data-share-url") || "";
      out.push({ idx, id, title, company, location, via, posted, salary, jobType, shareUrl });
    };
    getCards().forEach((c, i) => push(c, i));
    return out;
  });
}

// Cards loaded by lazy scroll carry a data-share-url with an EMPTY q param, which Google
// answers with a 500. htidocid is always intact — rebuild the canonical detail URL from it.
function canonicalShare(url) {
  const m = String(url || "").match(/htidocid=([^&#]+)/);
  if (!m) return url || "";
  return `https://www.google.com/search?ibp=htl;jobs&q=${encodeURIComponent(QUERY)}&htidocid=${m[1]}&hl=en&gl=in`;
}

// Open a job's share URL and pull its JD + apply link. The detail page also lists OTHER
// jobs (each with their own Apply anchors), so we find the biggest JD text block first,
// then walk UP from it to the pane that contains an Apply anchor — that anchor is ours.
async function fetchDetail(rawShareUrl, expect = "") {
  const shareUrl = canonicalShare(rawShareUrl);
  // Politeness: 6-10s between detail loads — Google soft-rate-limits rapid navigation
  // (serves a degraded page with no JD long before showing a captcha).
  await sleep(6000 + Math.random() * 4000);
  await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(2800);
  if (await isChallenged()) {
    // One 90s backoff, then retry once — the soft wall usually clears.
    console.error("  … rate-limited, backing off 90s");
    await sleep(90000);
    await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(2800);
  }
  if (await isChallenged()) return { walled: true, apply: "", jd: "" };
  return page.evaluate((expectToken) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    let jdEl = null, best = "";
    for (const el of document.querySelectorAll("div, span")) {
      const t = (el.innerText || "").trim();
      if (t.length > best.length && t.length > 200 && !/More jobs|Apply on/i.test(t.slice(0, 100)) && el.querySelectorAll("div,span,a").length < 40) { best = t; jdEl = el; }
    }
    let apply = "";
    for (let up = jdEl; up && up !== document.body; up = up.parentElement) {
      const a = [...up.querySelectorAll("a[href]")].find((x) => /^apply/i.test(clean(x.innerText)) && /^https?:/.test(x.href) && !x.href.includes("google.com/search"));
      if (a) { apply = a.href; break; }
    }
    // Degraded (rate-limited) pages serve a short "Sign in to create an email
    // notification…" blurb instead of the JD — treat anything like that as NO JD.
    if (best.length < 400 || /Sign in to create an email notification/i.test(best)) best = "";
    // WRONG-PANE GUARD: the page also lists neighboring jobs. If the pane we landed on
    // never mentions this job's company/title token, we grabbed a NEIGHBOR's JD + apply
    // link (e.g. Teamware row got State Street's URL) — return nothing instead of lies.
    if (expectToken && best && !best.toLowerCase().includes(expectToken)) { best = ""; apply = ""; }
    return { walled: false, apply, jd: best.slice(0, 6000) };
  }, String(expect || "").toLowerCase().split(/\s+/)[0] || "");
}

mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync("data/.dispatch", { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: PROBE_MODE ? false : HEADLESS,
  channel: "chrome",
  viewport: { width: 1366, height: 900 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  args: ["--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
const page = ctx.pages()[0] || (await ctx.newPage());

if (PROBE_MODE) {
  await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(4000);
  const challenged = await isChallenged();
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2200); await sleep(700); }
  writeFileSync("data/.dispatch/google-probe.html", await page.content());
  await page.screenshot({ path: "data/.dispatch/google-probe.png", fullPage: false }).catch(() => {});
  const cards = await scrapeCards();
  console.error(`Probe ${page.url()} — challenged=${challenged}, ${cards.length} cards. Saved data/.dispatch/google-probe.{html,png}`);
  for (const c of cards.slice(0, 10)) console.error(`  · ${c.company} — ${c.title} · ${c.location} · via ${c.via}`);
  await ctx.close();
  process.exit(challenged ? 1 : 0);
}

// ---------- BACKFILL ----------
// --backfill: re-visit share URLs of already-scanned jobs that lack a JD (e.g. after a
// rate-limit day) and fill in jd + apply_url in data/google-scan.json in place.
if (args.includes("--backfill")) {
  const path = "data/google-scan.json";
  const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { jobs: [] };
  const todo = (data.jobs || []).filter((j) => j.share_url && (!j.jd || j.jd.length < 400));
  console.error(`backfill: ${todo.length} job(s) missing JD`);
  let filled = 0;
  for (const j of todo) {
    try {
      j.share_url = canonicalShare(j.share_url); // repair lazy-scroll URLs saved before the fix
      if (j.url && j.url.includes("google.com/search")) { j.url = j.share_url; j.apply_url = j.share_url; }
      const detail = await fetchDetail(j.share_url, j.company);
      if (detail.walled) { console.error("  ⚠️ still walled — stopping backfill"); break; }
      if (detail.jd) { j.jd = detail.jd; filled++; }
      if (detail.apply) { j.apply_url = detail.apply; j.url = detail.apply; }
      console.error(`  [${filled}/${todo.length}] ${j.company} — JD ${detail.jd.length}ch${detail.apply ? "" : " (no apply link)"}`);
    } catch (e) { console.error(`  ⚠️ ${j.company}: ${e.message}`); }
  }
  writeFileSync(path, JSON.stringify(data, null, 2));
  writeFileSync(JSON_OUT, JSON.stringify(data, null, 2));
  await ctx.close();
  console.error(`✅ backfilled ${filled} JD(s)`);
  process.exit(0);
}

// ---------- SCAN ----------
const seen = loadHistory();
const jobs = [];
const skipped = [];
let walled = false;

try {
  await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(4500);
  if (await isChallenged()) { walled = true; throw new Error("Google 'unusual traffic' captcha wall — run with a visible window once to clear it."); }
  // Scroll the list to lazy-load more cards.
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 2400); await sleep(700); }
  const cards = await scrapeCards();
  console.error(`  — jobs tab: ${cards.length} cards`);
  if (cards.length === 0) { walled = true; throw new Error("0 cards on the jobs tab — layout change or wall. Run --probe to inspect."); }

  // Pass 1 — filter on list data only (no navigation yet).
  const candidates = [];
  for (const c of cards) {
    if (candidates.length >= MAX) break;
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (/\bintern(ship)?\b/i.test(c.title)) { skipped.push(`${c.company} — ${c.title} (internship)`); continue; }
    if (!DEVOPS_TITLE.test(c.title)) { skipped.push(`${c.company} — ${c.title} (not DevOps family)`); continue; }
    if (!isFresh24h(c.posted)) { skipped.push(`${c.company} — ${c.title} (posted "${c.posted || "unknown"}" — outside strict 24h)`); continue; }
    if (c.location && !/hyderabad|secunderabad|telangana|anywhere|remote|work from home/i.test(c.location)) { skipped.push(`${c.company} — ${c.title} (${c.location} — not Hyderabad)`); continue; }
    const band = fitsBand(parseExp(`${c.title} ${c.salary}`));
    if (!band.fit) { skipped.push(`${c.company} — ${c.title} (${band.reason})`); continue; }
    candidates.push({ ...c, band });
  }
  console.error(`  — ${candidates.length} new in-band candidates; fetching details...`);

  // Pass 2 — visit each job's share URL for the JD + apply link (the list page is
  // no longer needed). If Google walls mid-way, keep list-level data for the rest.
  let detailWalled = false;
  for (const c of candidates) {
    let apply_url = "", jd = "";
    if (c.shareUrl && !detailWalled) {
      try {
        const detail = await fetchDetail(c.shareUrl, c.company);
        if (detail.walled) { detailWalled = true; console.error("  ⚠️ captcha on detail pages — keeping list-level data for the rest"); }
        else { apply_url = detail.apply; jd = detail.jd; }
      } catch {}
    }
    // Re-check the band with the full JD (it states experience where the card doesn't).
    const band2 = fitsBand(parseExp(jd));
    if (!band2.fit) { skipped.push(`${c.company} — ${c.title} (${band2.reason}, from JD)`); continue; }
    const share = canonicalShare(c.shareUrl);
    const url = apply_url || share || JOBS_URL;
    jobs.push({
      id: c.id, title: c.title, company: c.company,
      location: c.location || "Hyderabad", posted: c.posted || "", via: c.via || "",
      url, apply_url: url, share_url: share, jd,
      exp: band2.reason === "exp unknown (kept)" ? c.band.reason : band2.reason,
      source: "Google", discovered_via: "google-jobs",
    });
    console.error(`  [${jobs.length}] ${c.company} — ${c.title} · ${c.location} · via ${c.via}${jd ? ` · JD ${jd.length}ch` : ""}${apply_url ? "" : " · (no apply link)"}`);
  }
} catch (e) {
  console.error("⚠️ ", e.message);
} finally {
  await ctx.close();
}

// ---------- WRITE ----------
const now = new Date().toISOString();
const jsonStr = JSON.stringify({ scanned_at: now, source: "google", tier: 1, module: "module15-Google", query: QUERY, filter: '"devops engineer" Hyderabad ≤4yr', walled, count: jobs.length, jobs }, null, 2);
writeFileSync("data/google-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# Google Jobs Scan — ${now.slice(0, 10)}\n\nFilter: DevOps family · Hyderabad · required exp ≤ 4 yrs · strict last 24h\n${walled ? "\n> ⚠️ Google wall — run once without --headless to clear the captcha.\n" : ""}\n${jobs.length} in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Location:** ${j.location}\n- **Experience:** ${j.exp}\n- **Posted:** ${j.posted} · via ${j.via}\n- **Apply:** ${j.url}\n\n---\n\n`;
}
writeFileSync("data/google-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const p = (n) => String(n).padStart(2, "0");
  const dateStr = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 15 — Google Jobs Tab Scan (Hyderabad)\n\n" +
    "Rows added by the Google jobs-tab scan (search → Jobs vertical). Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (walled) content += `| ${slot} | Google | _(captcha wall — run once visible)_ | — | — | — | — | — | — | ❌ wall |\n`;
  else if (jobs.length === 0) content += `| ${slot} | Google | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | Google | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "..", "lib", "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} skipped:\n   - ` + skipped.slice(0, 20).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band Google jobs -> data/google-scan.json`);
// Desktop notifications disabled per Nikhil 2026-10-26 ("i should not receive
// notification as well"). The day-wise sheet is the only status surface.
if (false && process.platform === "darwin" && jobs.length > 0) {
  execFile("osascript", ["-e", `display notification "${jobs.length} new Google DevOps job(s) in Hyderabad" with title "career-ops scan"`], () => {});
}
process.exit(0);
