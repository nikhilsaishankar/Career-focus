#!/usr/bin/env node
// scan-nodeflair.mjs — scan NodeFlair (nodeflair.com) for DevOps roles via a REAL browser.
//
// NodeFlair is Cloudflare-walled (plain fetch + its API both 403), but the job listing is
// public (no login). We drive a real Chrome with the anti-detection flags that beat Cloudflare
// on Indeed, land on the homepage first, then open the jobs search and scrape the cards.
// Modeled on scan-cutshort.mjs + scan-indeed.mjs.
//
//   node scan-nodeflair.mjs --probe [url]  # dump rendered DOM for selector building
//   node scan-nodeflair.mjs [maxJobs]      # daily scan (no login needed)
//   --headless hides the window (may bot-wall; visible is safer)
//
// Search uses the exact phrase "DevOps Engineer". Filter: DevOps family, India, internships
// dropped, deduped via data/nodeflair-scan-history.tsv. Output: Tier2/module14-NodeFlair/.

import { chromium } from "playwright";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(homedir(), ".career-ops", "nodeflair-chrome-profile");
const HISTORY = "data/nodeflair-scan-history.tsv";
const RP = reportPaths();
const MOD = RP.mod(2, "module14-NodeFlair");
const STATUS = MOD.md("module14-NodeFlair.md");
const XLSX_OUT = MOD.xlsx("module14-NodeFlair.xlsx");
const JSON_OUT = MOD.json("module14-NodeFlair.json");

const HOME_URL = "https://nodeflair.com/";
const JOBS_URL = 'https://nodeflair.com/jobs?query=' + encodeURIComponent('"DevOps Engineer"') + '&countries=India';

const args = process.argv.slice(2);
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
async function isChallenged() {
  try { return /just a moment|verify you are|attention required/.test((await page.title()).toLowerCase()); } catch { return false; }
}

async function scrapeCards() {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    // Each card is a div.jobListingCard with an EMPTY overlay <a href="/jobs/<co>-<role>-<id>">.
    // Title lives in h2.jobListingCardTitle, company in p.companynameAndRating (the /companies/
    // link is just a "View Company" button — don't use it).
    for (const a of document.querySelectorAll('a[href*="/jobs/"]')) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/jobs\/[a-z0-9-]+?-(\d+)(?:\?|$)/i);
      if (!m) continue;
      const id = m[1]; // trailing numeric job id
      if (seen.has(id)) continue;
      const card = a.closest('[class*="jobListingCard"]') || a.parentElement;
      if (!card) continue;
      const titleEl = card.querySelector('[class*="jobListingCardTitle"]');
      const role = titleEl ? titleEl.textContent.replace(/\s+/g, " ").trim() : "";
      if (!role || role.length < 3) continue;
      seen.add(id);
      const compEl = card.querySelector('[class*="companynameAndRating"]');
      const company = compEl ? compEl.textContent.replace(/\s+/g, " ").trim() : "—";
      const locEl = card.querySelector('[class*="location" i], [class*="Location" i]');
      const location = locEl ? locEl.textContent.replace(/\s+/g, " ").trim() : "India";
      out.push({
        id, role, company: company || "—", location: location || "India",
        url: "https://nodeflair.com" + href.split("?")[0],
      });
    }
    return out;
  });
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
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(3000);
  await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(4000);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2200); await sleep(700); }
  writeFileSync("data/.dispatch/nodeflair-probe.html", await page.content());
  await page.screenshot({ path: "data/.dispatch/nodeflair-probe.png", fullPage: true }).catch(() => {});
  console.error(`Probe ${page.url()} — challenged=${await isChallenged()}, ${(await scrapeCards()).length} cards. Saved data/.dispatch/nodeflair-probe.{html,png}`);
  await ctx.close();
  process.exit(0);
}

// ---------- SCAN ----------
const seen = loadHistory();
const jobs = [];
const skipped = [];
let walled = false;

try {
  // Homepage-first (beats Cloudflare), then the jobs search.
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(3500);
  if (await isChallenged()) {
    const until = Date.now() + 35000;
    while (Date.now() < until) { await sleep(5000); if (!(await isChallenged())) break; }
  }
  await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  let cards = [];
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await isChallenged()) continue;
    cards = await scrapeCards();
    if (cards.length) break;
  }
  if (cards.length === 0) { walled = true; throw new Error("0 cards — Cloudflare wall or selectors changed. Run `node scan-nodeflair.mjs --probe`."); }
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2400); await sleep(800); }
  cards = await scrapeCards();
  console.error(`  — feed: ${cards.length} cards`);

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
const jsonStr = JSON.stringify({ scanned_at: now, source: "nodeflair", tier: 2, module: "module14-NodeFlair", filter: '"DevOps Engineer" India', walled, count: jobs.length, jobs }, null, 2);
writeFileSync("data/nodeflair-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# NodeFlair Scan — ${now.slice(0, 10)}\n\nFilter: DevOps family · India\n${walled ? "\n> ⚠️ Cloudflare/bot wall — run `node scan-nodeflair.mjs --probe`.\n" : ""}\n${jobs.length} in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Location:** ${j.location}\n- **JD link:** ${j.url}\n\n_(open the link for the JD)_\n\n---\n\n`;
}
writeFileSync("data/nodeflair-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 14 — NodeFlair Job Scan (Tier 2)\n\n" +
    "Rows added by the NodeFlair scan. Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (walled) content += `| ${slot} | NodeFlair | _(Cloudflare wall — run --probe)_ | — | — | — | — | — | — | ❌ wall |\n`;
  else if (jobs.length === 0) content += `| ${slot} | NodeFlair | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | NodeFlair | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped:\n   - ` + skipped.slice(0, 20).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band NodeFlair jobs -> Tier2/module14-NodeFlair/`);
if (process.platform === "darwin") {
  const msg = walled ? "NodeFlair wall — run scan-nodeflair.mjs --probe" : jobs.length > 0 ? `${jobs.length} new NodeFlair DevOps job(s). Open Claude: "process the scan"` : "No new NodeFlair jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · NodeFlair scan" sound name "Glass"`]);
}
process.exit(0);
