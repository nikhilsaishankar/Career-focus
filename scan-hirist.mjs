#!/usr/bin/env node
// scan-hirist.mjs — scan Hirist (hirist.tech) for fresh "DevOps Engineer" roles via a REAL browser.
//
// Hirist is login + JS walled, so we drive a real Chrome with YOUR saved session
// (auto-login from ~/.career-ops/credentials.json when the session is dead). Same
// model as scan-naukri.mjs / scan-instahyre.mjs.
//
//   node scan-hirist.mjs --login        # one-time interactive login (fallback)
//   node scan-hirist.mjs --probe [url]  # dump logged-in DOM for selector building
//   node scan-hirist.mjs [maxJobs]      # daily scan (auto-login if needed)
//   add --headless to hide the window (may bot-wall; visible is safer)
//
// Filter: "DevOps Engineer", India-wide, 3-4 yr band, DevOps family kept.
// Output: Tier2/module05-Hirist/ (md + xlsx + json), dedup via data/hirist-scan-history.tsv.

import { chromium } from "playwright";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(homedir(), ".career-ops", "hirist-chrome-profile");
const HISTORY = "data/hirist-scan-history.tsv";
const CREDS_FILE = join(homedir(), ".career-ops", "credentials.json");
const RP = reportPaths();
const MOD = RP.mod(2, "module05-Hirist");
const STATUS = MOD.md("module05-Hirist.md");
const XLSX_OUT = MOD.xlsx("module05-Hirist.xlsx");
const JSON_OUT = MOD.json("module05-Hirist.json");

const LOGIN_URL = "https://www.hirist.tech/login";
const JOBS_URL = "https://www.hirist.tech/search/devops-engineer-jobs?minexp=2&maxexp=4"; // DevOps search, below 4 yr (per user)

const args = process.argv.slice(2);
const LOGIN_MODE = args.includes("--login");
const PROBE_MODE = args.includes("--probe");
const HEADLESS = args.includes("--headless");
const positional = args.filter((a) => !a.startsWith("--"));
const MAX = parseInt(positional.find((a) => /^\d+$/.test(a)) || "10", 10);
const PROBE_URL = positional.find((a) => a.startsWith("http")) || JOBS_URL;

const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadCreds(key) { try { return JSON.parse(readFileSync(CREDS_FILE, "utf8"))[key] || null; } catch { return null; } }
function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

// Hirist is a SPA — auth may live in a cookie OR localStorage token. Treat "logged in"
// as: not on the login route AND (a non-analytics cookie OR a localStorage auth token).
async function authState(page, ctx) {
  let url = "";
  try { url = page.url(); } catch {}
  const onLogin = /\/login\b|\/register\b/i.test(url);
  const cookies = await ctx.cookies("https://www.hirist.tech").catch(() => []);
  const authCookie = cookies.some((c) => /(session|token|auth|jwt|jsessionid|hirist)/i.test(c.name) && (c.value || "").length > 10);
  let lsToken = false;
  try { lsToken = await page.evaluate(() => Object.keys(localStorage).some((k) => /(token|auth|jwt|user|session)/i.test(k) && (localStorage.getItem(k) || "").length > 10)); } catch {}
  return { onLogin, loggedIn: !onLogin && (authCookie || lsToken) };
}

async function autoLogin(page, ctx, creds) {
  if (!creds) return false;
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Wait for the React login form to actually mount before typing.
    await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 20000 });
    await sleep(800);
    const emailEl = page.locator('input[name="email"], input[type="email"]').first();
    const passEl = page.locator('input[name="password"], input[type="password"]').first();
    await emailEl.click({ timeout: 4000 }).catch(() => {});
    await emailEl.fill(creds.user, { timeout: 5000 });
    await passEl.fill(creds.pass, { timeout: 5000 });
    await sleep(400);
    // The login CTA is a <button type="submit"> labelled "Login" inside the form.
    let clicked = false;
    for (const s of ['button[type="submit"]:has-text("Login")', 'button:has-text("Login")', 'button[type="submit"]']) {
      const l = page.locator(s).first();
      if (await l.count().catch(() => 0)) { try { await l.click({ timeout: 5000 }); clicked = true; break; } catch {} }
    }
    if (!clicked) { try { await passEl.press("Enter"); } catch {} }
    // Poll for either a session token/cookie OR navigation away from /login.
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const st = await authState(page, ctx);
      if (st.loggedIn) return true;
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
});
const page = ctx.pages()[0] || (await ctx.newPage());

if (LOGIN_MODE) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.error("\n👉 Chrome is open. Log into Hirist (OTP if asked). Waiting up to 10 min...");
  const deadline = Date.now() + 600000;
  let ok = false;
  while (Date.now() < deadline) { await sleep(3000); if ((await authState(page, ctx)).loggedIn) { ok = true; break; } }
  await sleep(1500); await ctx.close();
  console.error(ok ? "✅ Login detected; session saved." : "⚠️ Login not detected in 10 min.");
  process.exit(ok ? 0 : 1);
}

if (PROBE_MODE) {
  let st = await (async () => { await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); await sleep(2500); return authState(page, ctx); })();
  if (!st.loggedIn) { if (await autoLogin(page, ctx, loadCreds("hirist"))) { await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); await sleep(2500); st = await authState(page, ctx); } }
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2200); await sleep(700); }
  writeFileSync("data/.dispatch/hirist-probe.html", await page.content());
  await page.screenshot({ path: "data/.dispatch/hirist-probe.png", fullPage: true }).catch(() => {});
  console.error(`Probe ${page.url()} — loggedIn=${st.loggedIn}. Saved data/.dispatch/hirist-probe.{html,png}`);
  await ctx.close();
  process.exit(st.loggedIn ? 0 : 1);
}

// ---------- SCAN ----------
const EXP_MIN = 3, EXP_MAX = 4; // below-4-yr band (per user); drop roles whose floor is 5+
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
  const lo = exp.lo, hi = exp.hi ?? exp.lo;
  // Rule (per user): BELOW 4 yrs only — drop any role whose MINIMUM required experience is
  // 4+ (i.e. floor >= 4). A 3.5-yr candidate keeps roles like 1-2, 2-4, 3-4, 3-5; drops 4-10.
  if (lo >= EXP_MAX) return { fit: false, reason: `${lo}-${hi} yrs (needs 4+)` };
  return { fit: true, reason: `${lo}-${hi} yrs (<4 ok)` };
}

async function scrapeCards() {
  return page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll(".joblist-card-v2")) {
      const a = card.querySelector('a[href^="/j/"]');
      const href = a ? a.getAttribute("href") : "";
      const id = (href.match(/-(\d+)(?:\?|$)/) || [])[1] || href;
      const t = (sel) => { const e = card.querySelector(sel); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; };
      const full = t('[data-testid="job_title"]');
      if (!full) continue;
      let company = full, role = full;
      const idx = full.indexOf(" - ");
      if (idx > -1) { company = full.slice(0, idx).trim(); role = full.slice(idx + 3).trim(); }
      out.push({
        id: String(id), full, company, role,
        exp: t('[data-testid="job_experience"]'),
        location: t('[data-testid="job_location"]'),
        url: href ? "https://www.hirist.tech" + href.split("?")[0] : "",
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
  await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(2500);
  let st = await authState(page, ctx);
  if (!st.loggedIn) {
    console.error("  session dead — auto-logging in with stored creds...");
    if (await autoLogin(page, ctx, loadCreds("hirist"))) { await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45000 }); await sleep(2500); st = await authState(page, ctx); }
  }
  if (!st.loggedIn) { walled = true; throw new Error("not logged in — run `node scan-hirist.mjs --login` or set creds."); }

  try { await page.waitForSelector(".joblist-card-v2", { timeout: 12000 }); } catch {}
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2400); await sleep(800); }
  const cards = await scrapeCards();
  console.error(`  — feed: ${cards.length} cards`);

  for (const c of cards) {
    if (jobs.length >= MAX) break;
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (/\bintern(ship)?\b/i.test(c.role)) { skipped.push(`${c.company} — ${c.role} (internship)`); continue; }
    if (!DEVOPS_TITLE.test(c.role)) { skipped.push(`${c.company} — ${c.role} (title not in DevOps family)`); continue; }
    const band = fitsBand(parseExp(c.exp));
    if (!band.fit) { skipped.push(`${c.company} — ${c.role} (${band.reason})`); continue; }

    // Fetch the full JD from the job page.
    let jd = "";
    if (c.url) {
      try {
        const jp = await ctx.newPage();
        await jp.goto(c.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(1800);
        jd = await jp.evaluate(() => {
          const sels = ['[data-testid*="description" i]', '[class*="jobDetail" i]', '[class*="description" i]', "article", "main"];
          for (const s of sels) { const e = document.querySelector(s); if (e && e.textContent.trim().length > 120) return e.textContent.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); }
          return (document.body.textContent || "").replace(/\s+/g, " ").trim().slice(0, 6000);
        });
        await jp.close();
      } catch {}
    }
    jobs.push({ id: c.id, title: c.role, company: c.company, location: c.location || "India", posted: "", url: c.url, apply_url: c.url, exp: band.reason, jd: jd.slice(0, 6000) });
    console.error(`  [${jobs.length}] ${c.company} — ${c.role}  ·  ${band.reason}  ·  ${c.location}`);
    await sleep(400);
  }
} catch (e) {
  console.error("⚠️ ", e.message);
} finally {
  await ctx.close();
}

// ---------- WRITE ----------
const now = new Date().toISOString();
const jsonStr = JSON.stringify({ scanned_at: now, source: "hirist", tier: 2, module: "module05-Hirist", filter: '"DevOps Engineer" India 3-4yr', walled, count: jobs.length, jobs }, null, 2);
writeFileSync("data/hirist-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# Hirist Scan — ${now.slice(0, 10)}\n\nFilter: \`"DevOps Engineer"\` · India · 3-4 yr band\n${walled ? "\n> ⚠️ Login wall — run `node scan-hirist.mjs --login`.\n" : ""}\n${jobs.length} in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Location:** ${j.location}\n- **Experience:** ${j.exp}\n- **JD link:** ${j.url}\n\n${j.jd ? j.jd.slice(0, 4000) : "_(open the link for the JD)_"}\n\n---\n\n`;
}
writeFileSync("data/hirist-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 05 — Hirist Job Scan (Tier 2)\n\n" +
    "Rows added by the Hirist scan. Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (walled) content += `| ${slot} | Hirist | _(login wall — run --login)_ | — | — | — | — | — | — | ❌ wall |\n`;
  else if (jobs.length === 0) content += `| ${slot} | Hirist | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | Hirist | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped:\n   - ` + skipped.slice(0, 20).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band Hirist jobs -> Tier2/module05-Hirist/`);
if (process.platform === "darwin") {
  const msg = walled ? "Hirist session expired — run scan-hirist.mjs --login" : jobs.length > 0 ? `${jobs.length} new Hirist DevOps job(s). Open Claude: "process the scan"` : "No new Hirist jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · Hirist scan" sound name "Glass"`]);
}
process.exit(0);
