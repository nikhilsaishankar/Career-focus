#!/usr/bin/env node
// scan-cutshort.mjs — scan Cutshort (cutshort.io) for fresh DevOps roles via a REAL browser.
//
// Cutshort is a client-rendered SPA (the HTML ships no job data — React Query hydrates it
// after load), so plain fetch gets nothing. The job LISTING is public though (only applying
// needs login), so we render it in a real Chrome and scrape the cards. Modeled on
// scan-glassdoor.mjs.
//
//   node scan-cutshort.mjs --probe [url]  # dump rendered DOM for selector building
//   node scan-cutshort.mjs [maxJobs]      # daily scan (no login needed for the listing)
//   add --headless to hide the window
//
// Filter: DevOps family, India-wide, internships dropped.
// Output: Tier2/module10-Cutshort/ (md+xlsx+json), dedup via data/cutshort-scan-history.tsv.

import { chromium } from "playwright";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(homedir(), ".career-ops", "cutshort-chrome-profile");
const HISTORY = "data/cutshort-scan-history.tsv";
const RP = reportPaths();
const MOD = RP.mod(2, "module10-Cutshort");
const STATUS = MOD.md("module10-Cutshort.md");
const XLSX_OUT = MOD.xlsx("module10-Cutshort.xlsx");
const JSON_OUT = MOD.json("module10-Cutshort.json");

const JOBS_URL = "https://cutshort.io/jobs/devops-jobs";

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

async function scrapeCards() {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    // Cutshort job links route to /job/<slug>. Anchor each card off that link, then read the
    // surrounding card container for company + location.
    for (const a of document.querySelectorAll('a[href*="/job/"]')) {
      const href = a.getAttribute("href") || "";
      const slug = (href.match(/\/job\/([^/?#]+)/) || [])[1];
      if (!slug || seen.has(slug)) continue;
      const role = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!role || role.length < 3) continue;
      seen.add(slug);
      // Cutshort uses hashed styled-component classes (unstable), but encodes location +
      // company in the slug: <Title-words>-<Location>-<Company-words>-<id8>. Derive the
      // location by matching a known city; company is left to process-time JD open.
      const CITIES = /(bengaluru|bangalore|hyderabad|hyder|chennai|pune|mumbai|delhi|ncr|gurgaon|gurugram|noida|kolkata|ahmedabad|kochi|cochin|jaipur|indore|chandigarh|coimbatore|remote)/i;
      const cityMatch = slug.match(CITIES);
      const location = cityMatch ? cityMatch[1].replace(/^hyder$/i, "Hyderabad").replace(/^bangalore$/i, "Bengaluru") : "India";
      out.push({
        id: slug, role, company: "—", location,
        url: href.startsWith("http") ? href.split("?")[0] : "https://cutshort.io" + href.split("?")[0],
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
  // Strip automation fingerprints so the listing renders headless.
  args: ["--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
const page = ctx.pages()[0] || (await ctx.newPage());

if (PROBE_MODE) {
  await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(3500);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2200); await sleep(800); }
  writeFileSync("data/.dispatch/cutshort-probe.html", await page.content());
  await page.screenshot({ path: "data/.dispatch/cutshort-probe.png", fullPage: true }).catch(() => {});
  const n = (await scrapeCards()).length;
  console.error(`Probe ${page.url()} — ${n} cards parsed. Saved data/.dispatch/cutshort-probe.{html,png}`);
  await ctx.close();
  process.exit(0);
}

// ---------- SCAN ----------
const seen = loadHistory();
const jobs = [];
const skipped = [];
let walled = false;

try {
  await page.goto(JOBS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(3500); // let React Query hydrate the listing
  try { await page.waitForSelector('a[href*="/job/"]', { timeout: 12000 }); } catch {}
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2400); await sleep(900); }
  const cards = await scrapeCards();
  console.error(`  — feed: ${cards.length} cards`);
  if (cards.length === 0) { walled = true; throw new Error("0 cards — listing did not render. Run `node scan-cutshort.mjs --probe` to inspect."); }

  for (const c of cards) {
    if (jobs.length >= MAX) break;
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (/\bintern(ship)?\b/i.test(c.role)) { skipped.push(`${c.company} — ${c.role} (internship)`); continue; }
    if (!DEVOPS_TITLE.test(c.role)) { skipped.push(`${c.company} — ${c.role} (not DevOps family)`); continue; }

    // Enrich from the JD page's JSON-LD (clean company + location), like scan-hirist.mjs.
    let company = c.company, location = c.location, jd = "";
    if (c.url) {
      try {
        const jp = await ctx.newPage();
        await jp.goto(c.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(1800);
        const info = await jp.evaluate(() => {
          const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
            .map((s) => s.textContent).find((t) => /JobPosting/.test(t));
          let company = "", location = "", desc = "";
          if (ld) {
            try {
              const j = JSON.parse(ld);
              company = (j.hiringOrganization && j.hiringOrganization.name) || "";
              const addr = j.jobLocation && (Array.isArray(j.jobLocation) ? j.jobLocation[0] : j.jobLocation);
              const a = addr && addr.address;
              location = (a && (a.addressLocality || a.addressRegion)) || "";
              desc = (j.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            } catch {}
          }
          // Fallback to the page <title>: "<Company> is hiring <Role> job in <City>".
          if (!company) { const m = document.title.match(/^(.+?)\s+is hiring/i); if (m) company = m[1].trim(); }
          return { company, location, desc };
        });
        if (info.company) company = info.company;
        if (info.location) location = info.location;
        jd = (info.desc || "").slice(0, 4000);
        await jp.close();
      } catch {}
    }
    jobs.push({ id: c.id, title: c.role, company: company || "—", location: location || c.location, posted: "", url: c.url, apply_url: c.url, jd });
    console.error(`  [${jobs.length}] ${company || "—"} — ${c.role}  ·  ${location || c.location}`);
    await sleep(300);
  }
} catch (e) {
  console.error("⚠️ ", e.message);
} finally {
  await ctx.close();
}

// ---------- WRITE ----------
const now = new Date().toISOString();
const jsonStr = JSON.stringify({ scanned_at: now, source: "cutshort", tier: 2, module: "module10-Cutshort", filter: "DevOps family · India", walled, count: jobs.length, jobs }, null, 2);
writeFileSync("data/cutshort-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# Cutshort Scan — ${now.slice(0, 10)}\n\nFilter: DevOps family · India\n${walled ? "\n> ⚠️ Listing did not render — run `node scan-cutshort.mjs --probe`.\n" : ""}\n${jobs.length} in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Location:** ${j.location}\n- **JD link:** ${j.url}\n\n_(open the link for the JD)_\n\n---\n\n`;
}
writeFileSync("data/cutshort-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 10 — Cutshort Job Scan (Tier 2)\n\n" +
    "Rows added by the Cutshort scan. Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (walled) content += `| ${slot} | Cutshort | _(did not render — run --probe)_ | — | — | — | — | — | — | ❌ wall |\n`;
  else if (jobs.length === 0) content += `| ${slot} | Cutshort | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | Cutshort | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped:\n   - ` + skipped.slice(0, 20).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band Cutshort jobs -> Tier2/module10-Cutshort/`);
if (process.platform === "darwin") {
  const msg = walled ? "Cutshort did not render — run scan-cutshort.mjs --probe" : jobs.length > 0 ? `${jobs.length} new Cutshort DevOps job(s). Open Claude: "process the scan"` : "No new Cutshort jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · Cutshort scan" sound name "Glass"`]);
}
process.exit(0);
