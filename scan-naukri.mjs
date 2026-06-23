#!/usr/bin/env node
// scan-naukri.mjs — scan Naukri for fresh "DevOps Engineer" roles via a REAL browser.
//
// Naukri's JSON API answers `406 recaptcha required` and its HTML page is an empty
// Next.js shell (jobs load client-side), so a plain fetch() gets NOTHING. The only
// reliable route is a real Chromium driving your logged-in Naukri session.
//
// This uses a DEDICATED Chrome profile at ~/.career-ops/naukri-chrome-profile
// (NOT your live Default profile — Chrome locks that while open). Log into Naukri
// ONCE and the session persists for every future run.
//
// FIRST TIME (one-time login):
//   node scan-naukri.mjs --login
//   → a Chrome window opens on Naukri's login page. Log in, then press Enter here.
//
// DAILY:
//   node scan-naukri.mjs [filterUrl] [maxJobs]
//   - filterUrl: optional Naukri search URL (role/location/exp/jobAge already applied).
//                Defaults to "DevOps Engineer" · India-wide · 3 yr · last 1 day.
//   - maxJobs:   default 10.
//   Add --headless to run without a visible window (Naukri may captcha-wall headless,
//   even with a session — a visible window is more reliable; default is visible).
//
// Output: data/naukri-scan.{json,md}, dedup via data/naukri-scan-history.tsv.

import { chromium } from "playwright";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const PROFILE_DIR = join(homedir(), ".career-ops", "naukri-chrome-profile");
const HISTORY = "data/naukri-scan-history.tsv"; // jobId \t date \t company \t title — never miss / never repeat
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RP = reportPaths(); // reports_stats/<YYYY-MM-DD>/
const MOD = RP.mod(1, "module02-Naukri"); // Tier1/module02-Naukri/
const STATUS = MOD.md("module02-Naukri.md");
const XLSX_OUT = MOD.xlsx("module02-Naukri.xlsx");
const JSON_OUT = MOD.json("module02-Naukri.json");

// --- args ---
const args = process.argv.slice(2);
const LOGIN_MODE = args.includes("--login");
const HEADLESS = args.includes("--headless");
const positional = args.filter((a) => !a.startsWith("--"));
// Freshness window in days (default 7). Naukri posts few DevOps roles per 24h, so a
// 1-day window comes back almost empty; 7 days captures the genuinely recent ones.
// Override with --days=N  (e.g. --days=1 for strict last-24h, --days=14 for wider).
const daysArg = args.find((a) => a.startsWith("--days="));
const FRESH_DAYS = daysArg ? parseInt(daysArg.split("=")[1], 10) : 1;

// Walk this many result pages (Naukri shows 1..10 then Next). Default 10 = full sweep.
// Override with --pages=N. Pagination URL = base slug + `-{N}` before the query string.
const pagesArg = args.find((a) => a.startsWith("--pages="));
const MAX_PAGES = pagesArg ? parseInt(pagesArg.split("=")[1], 10) : 10;

// Mirror the user's MANUAL search exactly (synced filter):
//   • k="devops engineer" (exact phrase) + location India + experience=4
//   • l=india → Location "India" explicit (India-wide)
//   • experience=4 → candidate band; the fitsBand() check below drops floor-5+ (keeps ≤4)
//   • NO jobAge param — it BREAKS Naukri's search and makes it return "recommended" junk
//     (Elk/Scala/Red Hat). Freshness is filtered in code from each card's "X days ago".
const DEFAULT_URL =
  "https://www.naukri.com/devops-engineer-jobs-in-india?k=%22devops%20engineer%22&l=india&experience=4";
const FILTER_URL = positional[0] && positional[0].startsWith("http") ? positional[0] : DEFAULT_URL;
const MAX = parseInt(positional.find((p) => /^\d+$/.test(p)) || "40", 10);
// DevOps family — keep ANY role in the DevOps umbrella, drop unrelated ones. Same as scan-devops.mjs.
const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release/i;

// Experience band: keep only roles overlapping [3, 4] years (mirrors scan-devops.mjs).
const EXP_MIN = 3;
const EXP_MAX = 4;

// Parse a min/max year range from a string like "3-5 Yrs", "5+ Yrs", "3 to 4 years".
function parseExp(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  let lo = null, hi = null;
  for (const m of t.matchAll(/(\d{1,2})\s*(?:-|to|–)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?|yoe)?/g)) {
    const a = +m[1], b = +m[2];
    lo = lo === null ? a : Math.min(lo, a);
    hi = hi === null ? b : Math.max(hi, b);
  }
  for (const m of t.matchAll(/(?:minimum\s+|min\.?\s+|at\s*least\s+)?(\d{1,2})\s*\+\s*(?:years?|yrs?|yoe)?/g)) {
    const a = +m[1];
    lo = lo === null ? a : Math.min(lo, a);
  }
  if (lo === null && hi === null) return null;
  return { lo: lo ?? hi, hi };
}
function fitsBand(exp) {
  if (!exp) return { fit: true, reason: "exp not stated (kept)" };
  const lo = exp.lo;
  const hi = exp.hi ?? exp.lo;
  // Rule: required experience must be ≤ 4 yrs. Drop only roles whose FLOOR is 5+;
  // keep ≤4 and lower (we shortlist via the platform exp filter where available).
  if (lo > EXP_MAX) return { fit: false, reason: `requires ${lo}+ yrs (above 4)` };
  return { fit: true, reason: `${exp.lo}${exp.hi ? "-" + exp.hi : "+"} yrs (≤4 ok)` };
}

// Parse Naukri's "X days/weeks/months ago" posted label into a day count.
// Returns days (number), or null if unparseable (kept, flagged).
function parsePostedDays(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/just now|few hours|today|hours? ago/.test(t)) return 0;
  let m;
  if ((m = t.match(/(\d+)\+?\s*days?\s*ago/))) return +m[1];
  if ((m = t.match(/(\d+)\+?\s*weeks?\s*ago/))) return +m[1] * 7;
  if ((m = t.match(/(\d+)\+?\s*months?\s*ago/))) return +m[1] * 30;
  if (/a week ago|1 week ago/.test(t)) return 7;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}
// Real wall = redirected to login/registration OR no auth cookie. (Do NOT sniff the word
// "captcha" — Naukri loads an invisible reCAPTCHA site-wide for the navbar login widget,
// so that substring is present on every page including good logged-in ones.)
async function authState(page, ctx) {
  let url = "";
  try { url = page.url(); } catch {}
  const redirected = /\/nlogin\/login|\/registration\b/i.test(url);
  const cookies = await ctx.cookies("https://www.naukri.com").catch(() => []);
  const loggedIn = cookies.some((c) => /nauk_at|nauk_rt/i.test(c.name) && c.value && c.value.length > 5);
  return { redirected, loggedIn };
}

mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync("data", { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: LOGIN_MODE ? false : HEADLESS,
  channel: "chrome", // use the real installed Chrome — looks legit, fewer bot challenges
  viewport: { width: 1366, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
});
const page = ctx.pages()[0] || (await ctx.newPage());

// ---------- LOGIN MODE: one-time, persist the session (auto-detect, no Enter needed) ----------
if (LOGIN_MODE) {
  await page.goto("https://www.naukri.com/nlogin/login", { waitUntil: "domcontentloaded" });
  console.error("\n👉 A Chrome window is open. Log into Naukri in it. Waiting up to 5 min for login...");
  const deadline = Date.now() + 300000;
  let ok = false;
  while (Date.now() < deadline) {
    await sleep(3000);
    let url = "";
    try { url = page.url(); } catch {}
    const cookies = await ctx.cookies("https://www.naukri.com").catch(() => []);
    const hasAuth = cookies.some((c) => /nauk_at|nauk_rt|^Naukri$|_t_us/i.test(c.name) && c.value && c.value.length > 5);
    if (hasAuth || /\/mnjuser/i.test(url)) { ok = true; break; }
  }
  await sleep(1500);
  await ctx.close();
  if (ok) console.error("✅ Login detected. Session saved to", PROFILE_DIR, "— future runs reuse it.");
  else console.error("⚠️  Didn't detect login in 5 min. If you DID log in, it may still be saved — try a scan. Otherwise re-run --login.");
  process.exit(ok ? 0 : 1);
}

// ---------- SCAN (walk every result page 1..MAX_PAGES) ----------
const seen = loadHistory();
const jobs = [];
const skipped = [];
let walled = false;
let pagesScanned = 0;

// Pagination: Naukri is a SPA — its page links carry NO query string and paginating by
// URL (`-2?k=...`) just resets to page 1 (the query forces a fresh page-1 search). The
// only reliable way to advance while preserving the filter is to CLICK the "Next" button.
// Returns false when there's no Next (last page) or the result set didn't change.
async function clickNextPage() {
  const before = await page.evaluate(() => {
    const n = document.querySelector(".srp-jobtuple-wrapper");
    return n ? n.getAttribute("data-job-id") : "";
  });
  const next = page.locator("a").filter({ hasText: /^Next$/ }).last();
  if ((await next.count()) === 0) return false;
  try {
    await next.scrollIntoViewIfNeeded();
    await next.click({ timeout: 6000 });
  } catch {
    return false;
  }
  // Wait until the first card's id changes (new page rendered).
  try {
    await page.waitForFunction(
      (b) => { const n = document.querySelector(".srp-jobtuple-wrapper"); return n && n.getAttribute("data-job-id") !== b; },
      before,
      { timeout: 12000 },
    );
    return true;
  } catch {
    return false; // content didn't change → treat as last page
  }
}

async function scrapeCards() {
  return page.evaluate(() => {
    const out = [];
    const nodes = document.querySelectorAll(".srp-jobtuple-wrapper, article.jobTuple, [data-job-id]");
    for (const n of nodes) {
      const a = n.querySelector("a.title, a.title-text, a[href*='/job-listings-']");
      if (!a) continue;
      const id = n.getAttribute("data-job-id") || (a.href.match(/-(\d+)(?:\?|$)/) || [])[1] || a.href;
      const grab = (sel) => { const e = n.querySelector(sel); return e ? e.textContent.trim() : ""; };
      out.push({
        id: String(id),
        title: (a.textContent || "").trim(),
        url: a.href.split("?")[0],
        company: grab("a.comp-name, .comp-name, .companyInfo, a.subTitle"),
        exp: grab(".exp .expwdth, .expwdth, .exp, span[title*='Yr'], li.experience"),
        posted: grab(".job-post-day, span[class*='job-post'], .styles_jhc__jd-date, span[class*='date']"),
        location: grab(".loc .locWdth, .locWdth, .loc, li.location"),
        cardText: (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
      });
    }
    return out;
  });
}

let prevFirstId = null;
try {
  for (let p = 1; p <= MAX_PAGES && jobs.length < MAX; p++) {
    if (p === 1) {
      await page.goto(FILTER_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(2200);
      const st1 = await authState(page, ctx);
      if (st1.redirected || !st1.loggedIn) {
        walled = true;
        throw new Error("not logged in (redirected/no session) — run `node scan-naukri.mjs --login`.");
      }
    } else {
      const advanced = await clickNextPage();
      if (!advanced) { console.error(`  page ${p}: no further pages — stopping.`); break; }
      await sleep(1200);
    }

    try {
      await page.waitForSelector(".srp-jobtuple-wrapper, article.jobTuple, [data-job-id]", { timeout: 12000 });
    } catch {
      const st2 = await authState(page, ctx);
      if (st2.redirected || !st2.loggedIn) { walled = true; throw new Error("login wall after load — run `node scan-naukri.mjs --login`."); }
    }
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2200); await sleep(600); }

    const cards = await scrapeCards();
    if (cards.length === 0) { console.error(`  page ${p}: no cards — end of results.`); break; }
    // Stuck-pagination guard: if this page's first card matches the previous page, Naukri
    // didn't actually advance — stop rather than re-scan the same rows.
    if (p > 1 && cards[0]?.id && cards[0].id === prevFirstId) { console.error(`  page ${p}: same as previous — end.`); break; }
    prevFirstId = cards[0]?.id;
    const freshCardIds = cards.filter((c) => c.id && !seen.has(c.id));
    pagesScanned = p;
    console.error(`  — page ${p}: ${cards.length} cards (${freshCardIds.length} new)`);

    for (const c of cards) {
      if (jobs.length >= MAX) break;
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      if (/\bintern(ship)?\b/i.test(c.title)) { skipped.push(`${c.company} — ${c.title} (internship)`); continue; }
      // Naukri ignores the k="..." exact-phrase quotes (it returns skill-related roles —
      // Elk/Scala/Red Hat/Data Engineer — regardless of title). So enforce the DevOps-family
      // match client-side on the title (same regex as scan-devops.mjs).
      if (!DEVOPS_TITLE.test(c.title)) {
        skipped.push(`${c.company} — ${c.title} (title not in DevOps family)`);
        continue;
      }
      const ageDays = parsePostedDays(c.posted);
      if (ageDays != null && ageDays > FRESH_DAYS) {
        skipped.push(`${c.company} — ${c.title} (${c.posted}, older than ${FRESH_DAYS}d)`);
        continue;
      }
      const expStr = c.exp || c.cardText;
      const band = fitsBand(parseExp(expStr));
      if (!band.fit) { skipped.push(`${c.company} — ${c.title} (${band.reason})`); continue; }

      // Open the JD in a fresh tab and extract the description text.
      let jd = "";
      try {
        const jp = await ctx.newPage();
        await jp.goto(c.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(1500);
        jd = await jp.evaluate(() => {
          const sel = [
            ".styles_JDC__dang-inner-html__h0K4t",
            ".dang-inner-html",
            'section[class*="job-desc"]',
            ".job-desc-container",
            "#job_description",
          ];
          for (const s of sel) { const e = document.querySelector(s); if (e && e.textContent.trim().length > 80) return e.textContent.replace(/\s+\n/g, "\n").trim(); }
          const main = document.querySelector("main, .styles_jd-container__") || document.body;
          return (main.textContent || "").replace(/\s+/g, " ").trim().slice(0, 6000);
        });
        await jp.close();
      } catch { /* JD optional — keep the card */ }

      jobs.push({
        id: c.id, title: c.title, company: c.company, location: c.location,
        posted: c.posted, url: c.url, apply_url: c.url, exp: band.reason, jd: jd.slice(0, 6000),
      });
      console.error(`  [${jobs.length}] p${p} · ${c.company} — ${c.title}  ·  ${band.reason}  ·  ${c.posted || "?"}`);
      await sleep(400);
    }
  }
} catch (e) {
  console.error("⚠️ ", e.message);
} finally {
  await ctx.close();
}
console.error(`\n📄 Scanned ${pagesScanned} page(s).`);

// ---------- WRITE ----------
const now = new Date().toISOString();
const naukriJson = JSON.stringify({ scanned_at: now, source: "naukri", tier: 1, module: "module02-Naukri", filter_url: FILTER_URL, fresh_days: FRESH_DAYS, pages_scanned: pagesScanned, walled, count: jobs.length, jobs }, null, 2);
writeFileSync("data/naukri-scan.json", naukriJson); // kept for pipeline compatibility
writeFileSync(JSON_OUT, naukriJson); // lives with md+xlsx in the module folder
let md = `# Naukri Scan — ${now.slice(0, 10)}\n\nFilter: ${FILTER_URL}\n${walled ? "\n> ⚠️ Login/captcha wall hit — run `node scan-naukri.mjs --login` to re-authenticate.\n" : ""}\n${jobs.length} in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n`;
  md += `- **Location:** ${j.location}\n- **Experience:** ${j.exp}\n- **Posted:** ${j.posted || "?"}\n- **JD link:** ${j.url}\n\n`;
  md += `${j.jd ? j.jd.slice(0, 4000) : "_(JD not retrieved — open the link)_"}\n\n---\n\n`;
}
writeFileSync("data/naukri-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

// Write the daily FUNNEL TABLE (same standard as the LinkedIn funnel). Scan fills New +
// Link; the agent fills JD Fit / ATS / Pass / Résumé / Status during "process the scan".
{
  const d = new Date();
  const hour = d.getHours();
  const slot = hour < 12 ? "🌅" : hour < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 02 — Naukri Job Scan (Tier 1)\n\n" +
    "Rows added by the Naukri scan. Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready to apply / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (walled) {
    content += `| ${slot} | Naukri | _(login/captcha wall — run --login)_ | — | — | — | — | — | — | ❌ wall |\n`;
  } else if (jobs.length === 0) {
    content += `| ${slot} | Naukri | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  } else {
    for (const j of jobs) {
      content += `| ${slot} | Naukri | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
    }
  }
  writeFileSync(STATUS, content);
  // Regenerate the Excel view in reports_stats/ (best-effort — never break the scan).
  try {
    execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" });
  } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped:\n   - ` + skipped.join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band Naukri jobs -> data/naukri-scan.json + data/naukri-scan.md`);
if (walled) console.error("❌ Hit a login/captcha wall — re-run `node scan-naukri.mjs --login`.");
else if (jobs.length === 0) console.error("ℹ️  No new in-band (3-4 yr) Naukri jobs since last scan.");

if (process.platform === "darwin") {
  const msg = walled
    ? "Naukri session expired — run scan-naukri.mjs --login"
    : jobs.length > 0
      ? `${jobs.length} new Naukri DevOps job(s) in band. Open Claude: "process the scan"`
      : "No new in-band Naukri jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · Naukri scan" sound name "Glass"`]);
}
