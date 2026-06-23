#!/usr/bin/env node
// scan-simplyhired.mjs — zero-token scanner for SimplyHired India (simplyhired.co.in).
//
// SimplyHired server-renders its result cards (no login, no JS needed), so we fetch
// the search HTML over plain HTTP and parse the cards. Zero Claude tokens, zero browser.
//
//   node scan-simplyhired.mjs            # daily scan, default cap 30
//   node scan-simplyhired.mjs 15         # cap total new jobs at 15
//   node scan-simplyhired.mjs --pages=3  # scan first 3 result pages (default 2)
//
// Filter: "DevOps Engineer" family, India-wide, internships dropped, deduped via
// data/simplyhired-scan-history.tsv. Output: Tier2/module08-SimplyHired/ (md+xlsx+json)
// plus data/simplyhired-scan.{json,md}.

import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HISTORY = "data/simplyhired-scan-history.tsv";
const RP = reportPaths();
const MOD = RP.mod(2, "module08-SimplyHired");
const STATUS = MOD.md("module08-SimplyHired.md");
const XLSX_OUT = MOD.xlsx("module08-SimplyHired.xlsx");
const JSON_OUT = MOD.json("module08-SimplyHired.json");

const BASE = "https://www.simplyhired.co.in/search";
const QUERY = '"devops engineer"'; // double quotes = exact phrase (per user)
const LOCATION = "India";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const MAX = parseInt(positional.find((a) => /^\d+$/.test(a)) || "30", 10);
const PAGES = parseInt((args.find((a) => a.startsWith("--pages=")) || "").split("=")[1] || "2", 10);

const DEVOPS_TITLE =
  /dev[\s-]?(sec[\s-]?)?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release|kubernetes|\bk8s\b/i;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

const decode = (s) =>
  (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/gi, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();

async function fetchPage(page) {
  const url = `${BASE}?q=${encodeURIComponent(QUERY)}&l=${encodeURIComponent(LOCATION)}${page > 1 ? `&pn=${page}` : ""}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.text();
}

// SimplyHired renders cards in stable document order: each job has a /job/<key> title
// anchor, a data-testid="companyName" and a data-testid="searchSerpJobLocation". We pull
// the three ordered streams and zip by index (counts align on the result feed).
function parseCards(html) {
  const titles = [];
  const seenKey = new Set();
  // Title anchors: prefer the plain href (no data-mdref tracking blob).
  for (const m of html.matchAll(/href="\/job\/([A-Za-z0-9_-]{12,})"[^>]*>([^<]{3,120})<\/a>/g)) {
    const key = m[1];
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    titles.push({ id: key, title: decode(m[2]), url: `https://www.simplyhired.co.in/job/${key}` });
  }
  const companies = [...html.matchAll(/data-testid="companyName"[^>]*>([^<]{1,80})</g)].map((m) => decode(m[1]));
  const locations = [...html.matchAll(/data-testid="searchSerpJobLocation"[^>]*>([^<]{1,80})</g)].map((m) => decode(m[1]));
  return titles.map((t, i) => ({ ...t, company: companies[i] || "—", location: locations[i] || "India" }));
}

mkdirSync("data", { recursive: true });
const seen = loadHistory();
const jobs = [];
const skipped = [];
const errors = [];

for (let p = 1; p <= PAGES; p++) {
  let html;
  try {
    html = await fetchPage(p);
  } catch (e) {
    errors.push(`page ${p}: ${e.message}`);
    console.error(`  ⚠️  page ${p} failed: ${e.message}`);
    continue;
  }
  const cards = parseCards(html);
  console.error(`  — page ${p}: ${cards.length} cards`);
  if (!cards.length) break; // no more results
  for (const c of cards) {
    if (jobs.length >= MAX) break;
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (/\bintern(ship)?\b/i.test(c.title)) { skipped.push(`${c.company} — ${c.title} (internship)`); continue; }
    if (!DEVOPS_TITLE.test(c.title)) { skipped.push(`${c.company} — ${c.title} (not DevOps family)`); continue; }
    jobs.push({ id: c.id, title: c.title, company: c.company, location: c.location, url: c.url });
    console.error(`  [${jobs.length}] ${c.company} — ${c.title}  ·  ${c.location}`);
  }
  if (jobs.length >= MAX) break;
}

// ── Write ────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const jsonStr = JSON.stringify(
  { scanned_at: now, source: "simplyhired", tier: 2, module: "module08-SimplyHired",
    filter: '"DevOps Engineer" India', errors, count: jobs.length, jobs }, null, 2);
writeFileSync("data/simplyhired-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# SimplyHired Scan — ${now.slice(0, 10)}\n\nFilter: DevOps family · India\n${errors.length ? `\n> ⚠️ errors: ${errors.join("; ")}\n` : ""}\n${jobs.length} new in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Location:** ${j.location}\n- **JD link:** ${j.url}\n\n_(open the link for the full JD)_\n\n---\n\n`;
}
writeFileSync("data/simplyhired-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 08 — SimplyHired Scan (Tier 2)\n\n" +
    "Zero-token HTTP scan of SimplyHired India. Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (errors.length && jobs.length === 0) content += `| ${slot} | SimplyHired | _(fetch error — ${decode(errors[0]).slice(0, 40)})_ | — | — | — | — | — | — | ❌ err |\n`;
  else if (jobs.length === 0) content += `| ${slot} | SimplyHired | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | SimplyHired | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped (first 15):\n   - ` + skipped.slice(0, 15).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band SimplyHired jobs -> Tier2/module08-SimplyHired/`);
if (process.platform === "darwin") {
  const msg = jobs.length > 0 ? `${jobs.length} new SimplyHired DevOps job(s). Open Claude: "process the scan"` : "No new SimplyHired jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · SimplyHired scan" sound name "Glass"`]);
}
process.exit(0);
