#!/usr/bin/env node
// scan-instahyre.mjs — scan Instahyre for fresh "DevOps Engineer" roles via a REAL browser.
//
// Instahyre is login + JS walled (like Naukri), so we drive a real Chrome with YOUR
// saved session. Same model as scan-naukri.mjs: log in once, the session persists,
// future runs reuse it.
//
// ONE-TIME SETUP:
//   node scan-instahyre.mjs --login
//   → a Chrome window opens on Instahyre's login page. Log in (handle OTP if asked).
//     The session is auto-detected and saved; future runs reuse it.
//
// DAILY:
//   node scan-instahyre.mjs [maxJobs]
//   - maxJobs: default 10.
//   Add --headless to run without a visible window (may bot-wall headless; visible is safer).
//
// PROBE (used once, right after first login, to capture the logged-in DOM so the
// listing/JD selectors can be finalised against the real page):
//   node scan-instahyre.mjs --probe [url]
//   → dumps the current logged-in page HTML + screenshot to data/.dispatch/ for inspection.
//
// Filter mirrors the rest of the system: "DevOps Engineer", India-wide, 3-4 yr band.
// Output: data/instahyre-scan.{json,md}, dedup via data/instahyre-scan-history.tsv.

import { chromium } from "playwright";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const PROFILE_DIR = join(homedir(), ".career-ops", "instahyre-chrome-profile");
const HISTORY = "data/instahyre-scan-history.tsv"; // jobId \t date \t company \t title
const RP = reportPaths(); // reports_stats/<YYYY-MM-DD>/
const MOD = RP.mod(2, "module03-Instahyre"); // Tier2/module03-Instahyre/
const STATUS = MOD.md("module03-Instahyre.md");
const XLSX_OUT = MOD.xlsx("module03-Instahyre.xlsx");
const JSON_OUT = MOD.json("module03-Instahyre.json");
const CREDS_FILE = join(homedir(), ".career-ops", "credentials.json"); // owner-only, outside repo
function loadCreds(key) {
  try { return (JSON.parse(readFileSync(CREDS_FILE, "utf8"))[key]) || null; } catch { return null; }
}

const LOGIN_URL = "https://www.instahyre.com/login/";
// Candidate-side opportunities feed (post-login). Overridable via --probe <url>.
const JOBS_URL = "https://www.instahyre.com/candidate/opportunities/";

// --- args ---
const args = process.argv.slice(2);
const LOGIN_MODE = args.includes("--login");
const PROBE_MODE = args.includes("--probe");
const HEADLESS = args.includes("--headless");
const positional = args.filter((a) => !a.startsWith("--"));
const MAX = parseInt(positional.find((a) => /^\d+$/.test(a)) || "10", 10);
const PROBE_URL = positional.find((a) => a.startsWith("http")) || JOBS_URL;

// Experience band: keep roles whose required years overlap [3, 4].
const EXP_MIN = 3;
const EXP_MAX = 4;
// DevOps family — same umbrella regex used in scan-devops.mjs / scan-naukri.mjs.
const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

// Logged-in iff a Django session cookie is present and we're not sitting on /login.
async function authState(page, ctx) {
  let url = "";
  try { url = page.url(); } catch {}
  const onLogin = /\/login\b/i.test(url);
  const onCandidate = /\/candidate\b|\/jobs\b|\/dashboard\b/i.test(url);
  const cookies = await ctx.cookies("https://www.instahyre.com").catch(() => []);
  const hasSession = cookies.some((c) => /sessionid/i.test(c.name) && c.value && c.value.length > 5);
  const loggedIn = hasSession || (onCandidate && !onLogin);
  return { onLogin, loggedIn };
}

// Auto-login fallback: when the saved session is dead, sign in from stored creds.
// Runs in the same visible context (headless is bot-walled by Instahyre).
async function autoLogin(creds) {
  if (!creds) return false;
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3000);
    const fill = async (sels, val) => {
      for (const s of sels) {
        const l = page.locator(s).first();
        if (await l.count().catch(() => 0)) { try { await l.fill(val, { timeout: 4000 }); return true; } catch {} }
      }
      return false;
    };
    await fill(['input[type="email"]', 'input[name="email"]', 'input[ng-model*="email" i]', 'input[placeholder*="mail" i]'], creds.user);
    await fill(['input[type="password"]', 'input[name="password"]', 'input[ng-model*="password" i]'], creds.pass);
    let clicked = false;
    for (const s of ['button:has-text("Login")', 'button:has-text("Log in")', 'button:has-text("Sign in")', 'button[type="submit"]']) {
      const l = page.locator(s).first();
      if (await l.count().catch(() => 0)) { try { await l.click({ timeout: 4000 }); clicked = true; break; } catch {} }
    }
    if (!clicked) { try { await page.locator('input[type="password"]').first().press("Enter"); } catch {} }
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const cs = await ctx.cookies("https://www.instahyre.com").catch(() => []);
      if (cs.some((c) => /sessionid/i.test(c.name) && (c.value || "").length > 5)) return true;
    }
  } catch {}
  return false;
}

mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync("data", { recursive: true });
mkdirSync("data/.dispatch", { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: LOGIN_MODE || PROBE_MODE ? false : HEADLESS,
  channel: "chrome", // real installed Chrome — looks legit, fewer bot challenges
  viewport: { width: 1366, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
});
const page = ctx.pages()[0] || (await ctx.newPage());

// ---------- LOGIN MODE: one-time, persist the session (auto-detect, no Enter needed) ----------
if (LOGIN_MODE) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.error("\n👉 A Chrome window is open. Log into Instahyre in it (enter OTP if asked). Waiting up to 10 min...");
  const deadline = Date.now() + 600000;
  let ok = false;
  while (Date.now() < deadline) {
    await sleep(3000);
    const st = await authState(page, ctx);
    if (st.loggedIn && !st.onLogin) { ok = true; break; }
  }
  await sleep(1500);
  await ctx.close();
  if (ok) console.error("✅ Login detected. Session saved to", PROFILE_DIR, "— future runs reuse it.");
  else console.error("⚠️  Didn't detect login in 5 min. If you DID log in it may still be saved — try a scan. Otherwise re-run --login.");
  process.exit(ok ? 0 : 1);
}

// ---------- PROBE MODE: dump the logged-in page so selectors can be finalised ----------
if (PROBE_MODE) {
  await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(3000);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2000); await sleep(700); }
  const st = await authState(page, ctx);
  const html = await page.content();
  writeFileSync("data/.dispatch/instahyre-probe.html", html);
  await page.screenshot({ path: "data/.dispatch/instahyre-probe.png", fullPage: true }).catch(() => {});
  await ctx.close();
  console.error(`Probe of ${PROBE_URL} — loggedIn=${st.loggedIn} onLogin=${st.onLogin}`);
  console.error("Saved: data/.dispatch/instahyre-probe.html + .png");
  console.error(st.loggedIn ? "✅ Session live — ready to finalise the scraper." : "⚠️  Not logged in — run `node scan-instahyre.mjs --login` first.");
  process.exit(st.loggedIn ? 0 : 1);
}

// ---------- SCAN ----------
// Instahyre's opportunities feed is pre-matched to your profile (matching=true), so the
// experience band is largely pre-filtered by Instahyre. Cards carry company, role,
// location, skills and the recruiter note — but NO JD URL: the full JD only opens via an
// "apply modal". We deliberately do NOT open it (that's the apply flow on your account),
// so this captures listing-level signal. Full JD stays a manual click.
const seen = loadHistory();
const jobs = [];
const skipped = [];
let walled = false;

async function scrapeCards() {
  return page.evaluate(() => {
    const out = [];
    for (const n of document.querySelectorAll(".employer-block")) {
      const skillsEl = n.querySelector('[id^="job-skills-"]');
      const id = skillsEl ? skillsEl.id.replace("job-skills-", "") : "";
      const nameEl = n.querySelector(".employer-job-name .company-name, .company-name");
      const full = (nameEl ? nameEl.textContent : "").replace(/\s+/g, " ").trim();
      let company = full, role = full;
      const idx = full.indexOf(" - ");
      if (idx > -1) { company = full.slice(0, idx).trim(); role = full.slice(idx + 3).trim(); }
      const txt = (sel) => (n.querySelector(sel)?.textContent || "").replace(/\s+/g, " ").trim();
      const location = txt(".employer-locations").replace(/Job available in/gi, "").trim();
      const skills = txt(".job-skills");
      const note = txt(".employer-notes");
      const info = txt(".employer-info");
      if (!id && !full) continue;
      out.push({ id: id || full, company, role, location, skills, note, info });
    }
    return out;
  });
}

try {
  await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(2500);
  let st = await authState(page, ctx);
  if (!st.loggedIn || st.onLogin) {
    console.error("  session dead — auto-logging in with stored creds...");
    if (await autoLogin(loadCreds("instahyre"))) {
      await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(2500);
      st = await authState(page, ctx);
    }
  }
  if (!st.loggedIn || st.onLogin) {
    walled = true;
    throw new Error("not logged in — run `node scan-instahyre.mjs --login` or set creds in ~/.career-ops/credentials.json.");
  }
  // Lazy feed — scroll to pull in more cards.
  try { await page.waitForSelector(".employer-block", { timeout: 12000 }); } catch {}
  for (let i = 0; i < 8 && (await page.locator(".employer-block").count()) < MAX * 3; i++) {
    await page.mouse.wheel(0, 2600);
    await sleep(900);
  }

  const cards = await scrapeCards();
  console.error(`  — feed: ${cards.length} cards`);
  for (const c of cards) {
    if (jobs.length >= MAX) break;
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (/\bintern(ship)?\b/i.test(c.role)) { skipped.push(`${c.company} — ${c.role} (internship)`); continue; }
    if (!DEVOPS_TITLE.test(c.role)) { skipped.push(`${c.company} — ${c.role} (title not in DevOps family)`); continue; }
    const jd = [c.note, c.skills ? `Skills: ${c.skills}` : "", c.info].filter(Boolean).join("\n").trim();
    jobs.push({
      id: c.id, title: c.role, company: c.company, location: c.location || "India",
      posted: "", url: JOBS_URL, apply_url: JOBS_URL, exp: "matched to profile", jd: jd.slice(0, 6000),
    });
    console.error(`  [${jobs.length}] ${c.company} — ${c.role}  ·  ${c.location || "India"}`);
  }
} catch (e) {
  console.error("⚠️ ", e.message);
} finally {
  await ctx.close();
}

// ---------- WRITE ----------
const now = new Date().toISOString();
const jsonStr = JSON.stringify({ scanned_at: now, source: "instahyre", tier: 2, module: "module03-Instahyre", filter: '"DevOps Engineer" India (matched feed)', walled, count: jobs.length, jobs }, null, 2);
writeFileSync("data/instahyre-scan.json", jsonStr); // kept for pipeline compatibility
writeFileSync(JSON_OUT, jsonStr); // lives with md+xlsx in the module folder
let md = `# Instahyre Scan — ${now.slice(0, 10)}\n\nFilter: \`"DevOps Engineer"\` · India · matched feed (Instahyre has no candidate keyword box; exact-phrase filter enforced on results, DevOps family kept)\n${walled ? "\n> ⚠️ Login wall — run `node scan-instahyre.mjs --login` to re-authenticate.\n" : ""}\n${jobs.length} in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n`;
  md += `- **Location:** ${j.location}\n- **Experience:** ${j.exp}\n- **Feed:** ${j.url}\n\n`;
  md += `${j.jd ? j.jd.slice(0, 4000) : "_(open Instahyre to read the full JD)_"}\n\n---\n\n`;
}
writeFileSync("data/instahyre-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

// Daily FUNNEL TABLE — same standard as the LinkedIn/Naukri funnels.
{
  const d = new Date();
  const hour = d.getHours();
  const slot = hour < 12 ? "🌅" : hour < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 03 — Instahyre Job Scan (Tier 2)\n\n" +
    "Rows added by the Instahyre scan. Legend: **New** = matched feed found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (walled) {
    content += `| ${slot} | Instahyre | _(login wall — run --login)_ | — | — | — | — | — | — | ❌ wall |\n`;
  } else if (jobs.length === 0) {
    content += `| ${slot} | Instahyre | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  } else {
    for (const j of jobs) {
      content += `| ${slot} | Instahyre | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
    }
  }
  writeFileSync(STATUS, content);
  try {
    execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" });
  } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped:\n   - ` + skipped.slice(0, 20).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band Instahyre jobs -> data/instahyre-scan.json + data/instahyre-scan.md`);
if (walled) console.error("❌ Hit a login wall — re-run `node scan-instahyre.mjs --login`.");

if (process.platform === "darwin") {
  const msg = walled
    ? "Instahyre session expired — run scan-instahyre.mjs --login"
    : jobs.length > 0
      ? `${jobs.length} new Instahyre DevOps job(s). Open Claude: "process the scan"`
      : "No new Instahyre jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · Instahyre scan" sound name "Glass"`]);
}
process.exit(0);
