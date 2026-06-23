#!/usr/bin/env node
// scan-glassdoor.mjs — scan Glassdoor India (glassdoor.co.in) for fresh DevOps roles via a
// REAL browser with YOUR saved session. Modeled on scan-hirist.mjs / scan-instahyre.mjs.
//
// Glassdoor is Cloudflare + login walled and aggressively bot-detects, so we drive a real
// Chrome (channel:chrome) with a persistent profile and auto-login from
// ~/.career-ops/credentials.json (key "glassdoor"). Visible window is far more reliable
// than --headless here (headless trips the bot wall almost every time).
//
//   node scan-glassdoor.mjs --login        # one-time interactive login (do this FIRST)
//   node scan-glassdoor.mjs --probe [url]  # dump logged-in DOM for selector building
//   node scan-glassdoor.mjs [maxJobs]      # daily scan (auto-login if session dead)
//   add --headless to hide the window (likely to bot-wall; visible is safer)
//
// Filter: DevOps family, India-wide, 3-4 yr band, internships dropped.
// Output: Tier2/module09-Glassdoor/ (md+xlsx+json), dedup via data/glassdoor-scan-history.tsv.

import { chromium } from "playwright";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(homedir(), ".career-ops", "glassdoor-chrome-profile");
const HISTORY = "data/glassdoor-scan-history.tsv";
const CREDS_FILE = join(homedir(), ".career-ops", "credentials.json");
const RP = reportPaths();
const MOD = RP.mod(2, "module09-Glassdoor");
const STATUS = MOD.md("module09-Glassdoor.md");
const XLSX_OUT = MOD.xlsx("module09-Glassdoor.xlsx");
const JSON_OUT = MOD.json("module09-Glassdoor.json");

const LOGIN_URL = "https://www.glassdoor.co.in/profile/login_input.htm";
// India + "devops engineer" search (IN115 = India geo). Override by passing a URL to --probe.
const JOBS_URL = "https://www.glassdoor.co.in/Job/india-devops-engineer-jobs-SRCH_IL.0,5_IN115_KO6,21.htm";

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
function loadCreds(key) { try { return JSON.parse(readFileSync(CREDS_FILE, "utf8"))[key] || null; } catch { return null; } }
function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

// Glassdoor sets gdId / GSESSIONID / "at" cookies when logged in. Treat "logged in" as:
// not on the login route AND a session/auth cookie present.
async function authState(page, ctx) {
  let url = "";
  try { url = page.url(); } catch {}
  const onLogin = /login|signin|register/i.test(url);
  const cookies = await ctx.cookies("https://www.glassdoor.co.in").catch(() => []);
  const authCookie = cookies.some((c) => /(gdId|GSESSIONID|^at$|TS01|JSESSIONID|trs)/i.test(c.name) && (c.value || "").length > 8);
  return { onLogin, loggedIn: !onLogin && authCookie };
}

// Glassdoor login is two-step: email → Continue → password → Sign In.
async function autoLogin(page, ctx, creds) {
  if (!creds || !creds.user || !creds.pass) return false;
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1200);
    const emailEl = page.locator('input[name="username"], input#inlineUserEmail, input[type="email"]').first();
    await emailEl.waitFor({ timeout: 15000 });
    await emailEl.fill(creds.user, { timeout: 5000 });
    await sleep(400);
    // Click the "Continue with email" / next button to reveal the password field.
    for (const s of ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Sign In")']) {
      const b = page.locator(s).first();
      if (await b.count().catch(() => 0)) { try { await b.click({ timeout: 4000 }); break; } catch {} }
    }
    const passEl = page.locator('input[name="password"], input#inlineUserPassword, input[type="password"]').first();
    await passEl.waitFor({ timeout: 15000 });
    await passEl.fill(creds.pass, { timeout: 5000 });
    await sleep(400);
    for (const s of ['button[type="submit"]', 'button:has-text("Sign In")', 'button:has-text("Sign in")']) {
      const b = page.locator(s).first();
      if (await b.count().catch(() => 0)) { try { await b.click({ timeout: 4000 }); break; } catch {} }
    }
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) {
      await sleep(3000);
      if ((await authState(page, ctx)).loggedIn) return true;
    }
  } catch (e) { console.error("  autoLogin error:", e.message); }
  return false;
}

mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync("data/.dispatch", { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: LOGIN_MODE || PROBE_MODE ? false : HEADLESS,
  channel: "chrome",
  viewport: { width: 1366, height: 900 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  // Strip automation fingerprints so the bot wall lets headless through.
  args: ["--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
const page = ctx.pages()[0] || (await ctx.newPage());

if (LOGIN_MODE) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.error("\n👉 Chrome is open. Log into Glassdoor (solve any captcha). Waiting up to 10 min...");
  const deadline = Date.now() + 600000;
  let ok = false;
  while (Date.now() < deadline) { await sleep(3000); if ((await authState(page, ctx)).loggedIn) { ok = true; break; } }
  await sleep(1500); await ctx.close();
  console.error(ok ? "✅ Login detected; session saved." : "⚠️ Login not detected in 10 min.");
  process.exit(ok ? 0 : 1);
}

if (PROBE_MODE) {
  let st = await (async () => { await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); await sleep(2500); return authState(page, ctx); })();
  if (!st.loggedIn) { if (await autoLogin(page, ctx, loadCreds("glassdoor"))) { await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); await sleep(2500); st = await authState(page, ctx); } }
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2200); await sleep(700); }
  writeFileSync("data/.dispatch/glassdoor-probe.html", await page.content());
  await page.screenshot({ path: "data/.dispatch/glassdoor-probe.png", fullPage: true }).catch(() => {});
  console.error(`Probe ${page.url()} — loggedIn=${st.loggedIn}. Saved data/.dispatch/glassdoor-probe.{html,png}`);
  await ctx.close();
  process.exit(st.loggedIn ? 0 : 1);
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
  const lo = exp.lo;
  if (lo > EXP_MAX) return { fit: false, reason: `${lo}+ yrs (above 4)` };
  return { fit: true, reason: `${exp.lo}-${exp.hi ?? exp.lo} yrs (≤4 ok)` };
}

async function scrapeCards() {
  return page.evaluate(() => {
    const out = [];
    // Glassdoor lists each job in an <li data-test="jobListing"> with nested test-ids.
    const cards = document.querySelectorAll('[data-test="jobListing"], li.JobsList_jobListItem__wjTHv, .react-job-listing');
    for (const card of cards) {
      const t = (sel) => { const e = card.querySelector(sel); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; };
      const a = card.querySelector('a[data-test="job-title"], a[data-test="job-link"], a.JobCard_jobTitle__GLyJ1, a[href*="/job-listing/"], a[href*="/partner/jobListing"]');
      const href = a ? a.getAttribute("href") : "";
      const role = (a ? a.textContent : "").replace(/\s+/g, " ").trim() || t('[data-test="job-title"]');
      if (!role) continue;
      const company = t('[data-test="employer-short-name"]') || t('.EmployerProfile_compactEmployerName__9MGcV') || t('[class*="EmployerName"]');
      const location = t('[data-test="emp-location"]') || t('[class*="location"]');
      const id = (href.match(/jobListingId=(\d+)/) || href.match(/_IL[^_]*_(?:KO)?[^?]*?(\d{6,})/) || [])[1] || (href ? href.split("?")[0] : role + company);
      out.push({
        id: String(id), role, company: company || "—", location: location || "India",
        url: href ? (href.startsWith("http") ? href.split("?")[0] : "https://www.glassdoor.co.in" + href.split("?")[0]) : "",
      });
    }
    return out;
  });
}

const seen = loadHistory();
const jobs = [];
const skipped = [];
let walled = false;

try {
  // Homepage-first (no login needed) — Glassdoor serves public job cards, and landing on the
  // homepage first establishes a session that helps slip past the human-check even headless.
  await page.goto("https://www.glassdoor.co.in/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(3000);
  await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Poll for public cards to render (and scroll to trigger lazy load) before declaring a wall.
  let cards = [];
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    await sleep(3000);
    cards = await scrapeCards();
    if (cards.length) break;
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2400); await sleep(500); }
  }
  const st = await authState(page, ctx);
  console.error(`  — feed: ${cards.length} cards (loggedIn=${st.loggedIn})`);
  if (cards.length === 0) { walled = true; throw new Error("0 cards — bot/human-check wall (headless). Dispatcher falls back to visible/popup."); }

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
const jsonStr = JSON.stringify({ scanned_at: now, source: "glassdoor", tier: 2, module: "module09-Glassdoor", filter: "DevOps family · India · 3-4yr", walled, count: jobs.length, jobs }, null, 2);
writeFileSync("data/glassdoor-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# Glassdoor Scan — ${now.slice(0, 10)}\n\nFilter: DevOps family · India · 3-4 yr band\n${walled ? "\n> ⚠️ Bot/login wall — run `node scan-glassdoor.mjs --login`.\n" : ""}\n${jobs.length} in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Location:** ${j.location}\n- **Experience:** ${j.exp}\n- **JD link:** ${j.url}\n\n_(open the link for the JD)_\n\n---\n\n`;
}
writeFileSync("data/glassdoor-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 09 — Glassdoor Job Scan (Tier 2)\n\n" +
    "Rows added by the Glassdoor scan. Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (walled) content += `| ${slot} | Glassdoor | _(bot/login wall — run --login)_ | — | — | — | — | — | — | ❌ wall |\n`;
  else if (jobs.length === 0) content += `| ${slot} | Glassdoor | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | Glassdoor | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped:\n   - ` + skipped.slice(0, 20).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band Glassdoor jobs -> Tier2/module09-Glassdoor/`);
if (process.platform === "darwin") {
  const msg = walled ? "Glassdoor wall — run scan-glassdoor.mjs --login" : jobs.length > 0 ? `${jobs.length} new Glassdoor DevOps job(s). Open Claude: "process the scan"` : "No new Glassdoor jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · Glassdoor scan" sound name "Glass"`]);
}
process.exit(0);
