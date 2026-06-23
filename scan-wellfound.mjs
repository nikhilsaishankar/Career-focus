#!/usr/bin/env node
// scan-wellfound.mjs — scan Wellfound (wellfound.com, ex-AngelList Talent) for DevOps roles
// via a REAL browser with your saved session. Wellfound is Cloudflare + login walled (plain
// fetch = 403) and hides job listings behind login, so we drive a real Chrome with the
// anti-detection flags that beat Cloudflare on Indeed, and auto-login from
// ~/.career-ops/credentials.json (key "wellfound"). Modeled on scan-indeed.mjs + scan-glassdoor.mjs.
//
//   node scan-wellfound.mjs --login        # one-time interactive login (do this FIRST)
//   node scan-wellfound.mjs --probe [url]  # dump logged-in DOM for selector building
//   node scan-wellfound.mjs [maxJobs]      # daily scan (auto-login if session dead)
//   --headless hides the window (may bot-wall; visible is safer)
//
// Filter: DevOps family, India, internships dropped. Search uses the exact phrase
// "DevOps Engineer". Output: Tier2/module12-Wellfound/ (md+xlsx+json),
// dedup via data/wellfound-scan-history.tsv.

import { chromium } from "playwright";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(homedir(), ".career-ops", "wellfound-chrome-profile");
const HISTORY = "data/wellfound-scan-history.tsv";
const CREDS_FILE = join(homedir(), ".career-ops", "credentials.json");
const RP = reportPaths();
const MOD = RP.mod(2, "module12-Wellfound");
const STATUS = MOD.md("module12-Wellfound.md");
const XLSX_OUT = MOD.xlsx("module12-Wellfound.xlsx");
const JSON_OUT = MOD.json("module12-Wellfound.json");

const HOME_URL = "https://wellfound.com/";
const LOGIN_URL = "https://wellfound.com/login";
// India + DevOps role search. Wellfound role/location slugs: /role/l/<role>/<location>.
const JOBS_URL = "https://wellfound.com/role/l/devops-engineer/india";

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

async function isChallenged() {
  try {
    const t = (await page.title()).toLowerCase();
    return /just a moment|verify you are|attention required|additional verification/.test(t);
  } catch { return false; }
}
// Wellfound sets a "_wellfound" / logged_in_token cookie when authenticated.
async function authState(page, ctx) {
  let url = ""; try { url = page.url(); } catch {}
  const onLogin = /\/login\b/i.test(url);
  const cookies = await ctx.cookies("https://wellfound.com").catch(() => []);
  const authCookie = cookies.some((c) => /(logged_in|_wellfound|wf_session|angellist|_gist|session)/i.test(c.name) && (c.value || "").length > 8);
  return { onLogin, loggedIn: !onLogin && authCookie };
}

async function autoLogin(page, ctx, creds) {
  if (!creds || !creds.user || !creds.pass) return false;
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1500);
    const emailEl = page.locator('input[name="user[email]"], input#user_email, input[type="email"]').first();
    await emailEl.waitFor({ timeout: 15000 });
    await emailEl.fill(creds.user, { timeout: 5000 });
    const passEl = page.locator('input[name="user[password]"], input#user_password, input[type="password"]').first();
    await passEl.fill(creds.pass, { timeout: 5000 });
    await sleep(400);
    for (const s of ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Login")']) {
      const b = page.locator(s).first();
      if (await b.count().catch(() => 0)) { try { await b.click({ timeout: 4000 }); break; } catch {} }
    }
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) { await sleep(3000); if ((await authState(page, ctx)).loggedIn) return true; }
  } catch (e) { console.error("  autoLogin error:", e.message); }
  return false;
}

async function scrapeCards() {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    // Wellfound job links route to /jobs/<id>-<slug>. Anchor off those, climb to the card.
    for (const a of document.querySelectorAll('a[href*="/jobs/"]')) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/jobs\/(\d+)-/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      const role = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!role || role.length < 3) continue;
      seen.add(id);
      // Wellfound groups jobs UNDER a company header, so the company name lives in an ancestor,
      // not the job card. Walk up until we find a company link (/company/ or /startups/) or a
      // header, and read the name from there.
      let company = "";
      let node = a;
      for (let i = 0; i < 9 && node.parentElement && !company; i++) {
        node = node.parentElement;
        const cl = node.querySelector('a[href*="/company/"], a[href*="/startups/"], a[href*="/companies/"]');
        if (cl && cl.textContent.trim()) { company = cl.textContent.replace(/\s+/g, " ").trim(); break; }
        const h = node.querySelector('h1, h2, h3');
        if (h && h.textContent.trim() && h.textContent.trim().length < 50) company = h.textContent.replace(/\s+/g, " ").trim();
      }
      let card = a;
      for (let i = 0; i < 5 && card.parentElement; i++) card = card.parentElement;
      const txt = (sel) => { const e = card.querySelector(sel); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; };
      const location = txt('[class*="location" i]') || "";
      out.push({
        id, role, company: company || "—", location: location || "India",
        url: href.startsWith("http") ? href.split("?")[0] : "https://wellfound.com" + href.split("?")[0],
      });
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
  args: ["--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
const page = ctx.pages()[0] || (await ctx.newPage());

if (LOGIN_MODE) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.error("\n👉 Chrome is open. Log into Wellfound (solve any captcha). Waiting up to 10 min...");
  const deadline = Date.now() + 600000;
  let ok = false;
  while (Date.now() < deadline) { await sleep(3000); if ((await authState(page, ctx)).loggedIn) { ok = true; break; } }
  await sleep(1500); await ctx.close();
  console.error(ok ? "✅ Login detected; session saved." : "⚠️ Login not detected in 10 min.");
  process.exit(ok ? 0 : 1);
}

if (PROBE_MODE) {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(3000);
  let st = await authState(page, ctx);
  if (!st.loggedIn) { if (await autoLogin(page, ctx, loadCreds("wellfound"))) st = await authState(page, ctx); }
  await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(3500);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2200); await sleep(700); }
  writeFileSync("data/.dispatch/wellfound-probe.html", await page.content());
  await page.screenshot({ path: "data/.dispatch/wellfound-probe.png", fullPage: true }).catch(() => {});
  console.error(`Probe ${page.url()} — loggedIn=${st.loggedIn}, ${(await scrapeCards()).length} cards. Saved data/.dispatch/wellfound-probe.{html,png}`);
  await ctx.close();
  process.exit(0);
}

// ---------- SCAN ----------
const seen = loadHistory();
const jobs = [];
const skipped = [];
let walled = false;

try {
  // Homepage-first (beats Cloudflare), then ensure logged in, then go to the jobs search.
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(3500);
  let st = await authState(page, ctx);
  if (!st.loggedIn) {
    console.error("  not logged in — auto-logging in with stored creds...");
    if (await autoLogin(page, ctx, loadCreds("wellfound"))) st = await authState(page, ctx);
  }
  if (!st.loggedIn) { walled = true; throw new Error("not logged in — run `node scan-wellfound.mjs --login` once (Wellfound hides jobs behind login)."); }

  await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Poll for cards to render (SPA + brief Cloudflare check).
  let cards = [];
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await isChallenged()) continue;
    cards = await scrapeCards();
    if (cards.length) break;
  }
  if (cards.length === 0) { walled = true; throw new Error("0 cards — wall or selectors changed. Run `node scan-wellfound.mjs --probe`."); }
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2400); await sleep(800); }
  cards = await scrapeCards();
  console.error(`  — feed: ${cards.length} cards (loggedIn=${st.loggedIn})`);

  for (const c of cards) {
    if (jobs.length >= MAX) break;
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (/\bintern(ship)?\b/i.test(c.role)) { skipped.push(`${c.company} — ${c.role} (internship)`); continue; }
    if (!DEVOPS_TITLE.test(c.role)) { skipped.push(`${c.company} — ${c.role} (not DevOps family)`); continue; }
    jobs.push({ id: c.id, title: c.role, company: c.company, location: c.location, posted: "", url: c.url, apply_url: c.url });
    console.error(`  [${jobs.length}] ${c.company} — ${c.role}  ·  ${c.location}`);
  }
} catch (e) {
  console.error("⚠️ ", e.message);
} finally {
  await ctx.close();
}

// ---------- WRITE ----------
const now = new Date().toISOString();
const jsonStr = JSON.stringify({ scanned_at: now, source: "wellfound", tier: 2, module: "module12-Wellfound", filter: '"DevOps Engineer" India', walled, count: jobs.length, jobs }, null, 2);
writeFileSync("data/wellfound-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# Wellfound Scan — ${now.slice(0, 10)}\n\nFilter: DevOps family · India\n${walled ? "\n> ⚠️ Login/bot wall — run `node scan-wellfound.mjs --login`.\n" : ""}\n${jobs.length} in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Location:** ${j.location}\n- **JD link:** ${j.url}\n\n_(open the link for the JD)_\n\n---\n\n`;
}
writeFileSync("data/wellfound-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 12 — Wellfound Job Scan (Tier 2)\n\n" +
    "Rows added by the Wellfound scan. Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (walled) content += `| ${slot} | Wellfound | _(login/bot wall — run --login)_ | — | — | — | — | — | — | ❌ wall |\n`;
  else if (jobs.length === 0) content += `| ${slot} | Wellfound | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | Wellfound | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped:\n   - ` + skipped.slice(0, 20).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band Wellfound jobs -> Tier2/module12-Wellfound/`);
if (process.platform === "darwin") {
  const msg = walled ? "Wellfound wall — run scan-wellfound.mjs --login" : jobs.length > 0 ? `${jobs.length} new Wellfound DevOps job(s). Open Claude: "process the scan"` : "No new Wellfound jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · Wellfound scan" sound name "Glass"`]);
}
process.exit(0);
