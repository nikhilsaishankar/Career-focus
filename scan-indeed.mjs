#!/usr/bin/env node
// scan-indeed.mjs — scan Indeed India (in.indeed.com) for fresh DevOps roles via a REAL browser.
//
// Indeed is the most aggressive anti-bot board: a plain fetch returns 403 + Cloudflare
// "Additional Verification". A genuine Chrome (channel:chrome) with a persistent profile
// often passes the challenge for the public search results — no login needed to read the
// listing. If Indeed hard-walls (0 cards / challenge page), run --login once in the visible
// window (email is nikhilsaishankar@gmail.com; Indeed sends an email/OTP code you type in),
// and the saved session usually sails through afterwards. Modeled on scan-glassdoor.mjs.
//
//   node scan-indeed.mjs --login        # one-time interactive login / challenge solve
//   node scan-indeed.mjs --probe [url]  # dump DOM for selector building
//   node scan-indeed.mjs [maxJobs]      # daily scan
//   --headless hides the window (almost always trips the wall; visible is required)
//
// Filter: DevOps family, India-wide, last 7 days, 3-4 yr band, internships dropped.
// Output: Tier2/module11-Indeed/ (md+xlsx+json), dedup via data/indeed-scan-history.tsv.

import { chromium } from "playwright";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(homedir(), ".career-ops", "indeed-chrome-profile");
const HISTORY = "data/indeed-scan-history.tsv";
const RP = reportPaths();
const MOD = RP.mod(2, "module11-Indeed");
const STATUS = MOD.md("module11-Indeed.md");
const XLSX_OUT = MOD.xlsx("module11-Indeed.xlsx");
const JSON_OUT = MOD.json("module11-Indeed.json");

const LOGIN_URL = "https://secure.indeed.com/auth";
// India + "devops engineer", last 7 days (fromage=7), sorted by date.
const JOBS_URL = "https://in.indeed.com/jobs?q=devops+engineer&l=India&fromage=7&sort=date";

const args = process.argv.slice(2);
const LOGIN_MODE = args.includes("--login");
const PROBE_MODE = args.includes("--probe");
const HEADLESS = args.includes("--headless");
const positional = args.filter((a) => !a.startsWith("--"));
const MAX = parseInt(positional.find((a) => /^\d+$/.test(a)) || "15", 10);
const PROBE_URL = positional.find((a) => a.startsWith("http")) || JOBS_URL;

const DEVOPS_TITLE =
  /dev[\s-]?(sec[\s-]?)?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release|kubernetes|\bk8s\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

// Detect Cloudflare / Indeed bot challenge so we can report a clear "walled" status.
async function isChallenged() {
  try {
    const t = (await page.title()).toLowerCase();
    if (/just a moment|additional verification|verify you are|attention required/.test(t)) return true;
    const body = (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 400) : "")).toLowerCase();
    return /verify you are human|additional verification|checking your browser|enable javascript and cookies/.test(body);
  } catch { return false; }
}

async function scrapeCards() {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const cards = document.querySelectorAll('.job_seen_beacon, [data-testid="slider_item"], div.cardOutline');
    for (const card of cards) {
      const a = card.querySelector('h2.jobTitle a, a[data-jk], a[id^="job_"], [data-testid="job-title"] a, a.jcs-JobTitle');
      const jk = (a && (a.getAttribute("data-jk") || (a.id || "").replace(/^job_/, ""))) ||
        (card.querySelector("[data-jk]") && card.querySelector("[data-jk]").getAttribute("data-jk")) || "";
      const titleEl = card.querySelector('h2.jobTitle span[title], [data-testid="job-title"], h2.jobTitle a, a.jcs-JobTitle span');
      const role = (titleEl ? (titleEl.getAttribute("title") || titleEl.textContent) : (a ? a.textContent : "")).replace(/\s+/g, " ").trim();
      if (!role) continue;
      const id = jk || (a && a.getAttribute("href") || role);
      if (seen.has(id)) continue;
      seen.add(id);
      const t = (sel) => { const e = card.querySelector(sel); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; };
      const company = t('[data-testid="company-name"]') || t('.companyName') || t('span.css-1h7lukg');
      const location = t('[data-testid="text-location"]') || t('.companyLocation') || t('div.css-1restlb');
      const url = jk ? `https://in.indeed.com/viewjob?jk=${jk}` :
        (a && a.getAttribute("href") ? (a.getAttribute("href").startsWith("http") ? a.getAttribute("href") : "https://in.indeed.com" + a.getAttribute("href")) : "");
      out.push({ id: String(id), role, company: company || "—", location: location || "India", url });
    }
    return out;
  });
}

mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync("data/.dispatch", { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: LOGIN_MODE || PROBE_MODE ? false : HEADLESS,
  channel: "chrome",
  viewport: { width: 1366, height: 900 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  // Strip the automation fingerprints Cloudflare keys off (navigator.webdriver etc.) so the
  // Turnstile check can actually pass instead of looping. Indeed is the one board that needs this.
  args: ["--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
});
// Belt-and-suspenders: hide navigator.webdriver before any page script runs.
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
const page = ctx.pages()[0] || (await ctx.newPage());

if (LOGIN_MODE) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.error("\n👉 Chrome is open. Log into Indeed (email nikhilsaishankar@gmail.com → type the email/OTP code Indeed sends). Solve any captcha. Waiting up to 10 min...");
  const deadline = Date.now() + 600000;
  let ok = false;
  while (Date.now() < deadline) {
    await sleep(4000);
    const u = page.url();
    if (!/secure\.indeed\.com\/auth|\/account\/login/.test(u) && !(await isChallenged())) { ok = true; break; }
  }
  await sleep(1500); await ctx.close();
  console.error(ok ? "✅ Looks logged in; session saved." : "⚠️ Still on login/challenge after 10 min.");
  process.exit(ok ? 0 : 1);
}

if (PROBE_MODE) {
  await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(3000);
  const challenged = await isChallenged();
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2200); await sleep(700); }
  writeFileSync("data/.dispatch/indeed-probe.html", await page.content());
  await page.screenshot({ path: "data/.dispatch/indeed-probe.png", fullPage: true }).catch(() => {});
  const n = (await scrapeCards()).length;
  console.error(`Probe ${page.url()} — challenged=${challenged}, ${n} cards. Saved data/.dispatch/indeed-probe.{html,png}`);
  await ctx.close();
  process.exit(challenged ? 1 : 0);
}

// ---------- SCAN ----------
const EXP_MAX = 4;
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

const seen = loadHistory();
const jobs = [];
const skipped = [];
let walled = false;

try {
  // Homepage-first (per user): land on in.indeed.com like a human, then search from the box.
  // This establishes a clean session that passes Cloudflare where hitting /jobs directly walls.
  await page.goto("https://in.indeed.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(4000);
  if (await isChallenged()) {
    console.error("  Cloudflare challenge on homepage — waiting for it to clear...");
    const until = Date.now() + 35000;
    while (Date.now() < until) { await sleep(5000); if (!(await isChallenged())) { console.error("  cleared."); break; } }
  }
  // Type the query into the homepage search box and submit (fallback: direct URL).
  try {
    await page.fill('#text-input-what, input[name="q"]', '"devops engineer"', { timeout: 8000 }); // exact phrase (per user)
    await page.fill('#text-input-where, input[name="l"]', "India", { timeout: 8000 }).catch(() => {});
    await page.keyboard.press("Enter");
    console.error("  submitted homepage search...");
  } catch (e) {
    console.error("  search box not found, trying direct URL:", e.message);
    await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  }
  // Poll up to ~40s for the results page to render its cards (it loads behind a brief check).
  let cards = [];
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await isChallenged()) continue;
    cards = await scrapeCards();
    if (cards.length) break;
  }
  if (cards.length === 0) {
    walled = true;
    throw new Error("0 cards after homepage search — Cloudflare wall on the results page. Indeed stays on the web-search path.");
  }
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2400); await sleep(800); }
  cards = await scrapeCards();
  console.error(`  — feed: ${cards.length} cards`);

  for (const c of cards) {
    if (jobs.length >= MAX) break;
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (/\bintern(ship)?\b/i.test(c.role)) { skipped.push(`${c.company} — ${c.role} (internship)`); continue; }
    if (!DEVOPS_TITLE.test(c.role)) { skipped.push(`${c.company} — ${c.role} (not DevOps family)`); continue; }
    const band = fitsBand(parseExp(c.role));
    if (!band.fit) { skipped.push(`${c.company} — ${c.role} (${band.reason})`); continue; }
    jobs.push({ id: c.id, title: c.role, company: c.company, location: c.location, posted: "", url: c.url, apply_url: c.url, exp: band.reason });
    console.error(`  [${jobs.length}] ${c.company} — ${c.role}  ·  ${c.location}`);
  }
} catch (e) {
  console.error("⚠️ ", e.message);
} finally {
  await ctx.close();
}

// ---------- WRITE ----------
const now = new Date().toISOString();
const jsonStr = JSON.stringify({ scanned_at: now, source: "indeed", tier: 2, module: "module11-Indeed", filter: '"devops engineer" India last7d 3-4yr', walled, count: jobs.length, jobs }, null, 2);
writeFileSync("data/indeed-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# Indeed Scan — ${now.slice(0, 10)}\n\nFilter: DevOps family · India · last 7 days · 3-4 yr band\n${walled ? "\n> ⚠️ Cloudflare/bot wall — run `node scan-indeed.mjs --login`.\n" : ""}\n${jobs.length} in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Location:** ${j.location}\n- **Experience:** ${j.exp}\n- **JD link:** ${j.url}\n\n_(open the link for the JD)_\n\n---\n\n`;
}
writeFileSync("data/indeed-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 11 — Indeed Job Scan (Tier 2)\n\n" +
    "Rows added by the Indeed scan. Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (walled) content += `| ${slot} | Indeed | _(Cloudflare wall — run --login)_ | — | — | — | — | — | — | ❌ wall |\n`;
  else if (jobs.length === 0) content += `| ${slot} | Indeed | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | Indeed | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped:\n   - ` + skipped.slice(0, 20).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band Indeed jobs -> Tier2/module11-Indeed/`);
if (process.platform === "darwin") {
  const msg = walled ? "Indeed wall — run scan-indeed.mjs --login" : jobs.length > 0 ? `${jobs.length} new Indeed DevOps job(s). Open Claude: "process the scan"` : "No new Indeed jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · Indeed scan" sound name "Glass"`]);
}
process.exit(0);
