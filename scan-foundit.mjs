#!/usr/bin/env node
// scan-foundit.mjs — zero-token scanner for Foundit India (foundit.in, ex-Monster).
//
// Foundit's HTML search page is 403/bot-walled, but its middleware JSON API answers cleanly
// when called with a Referer header. No login, no browser, zero Claude tokens.
//
//   node scan-foundit.mjs            # daily scan, default cap 30
//   node scan-foundit.mjs 15         # cap total new jobs at 15
//
// Search uses the exact phrase "devops engineer". Filter: DevOps family, India, BELOW 4 yrs
// (drop roles whose minimum required experience is 4+), internships dropped, deduped via
// data/foundit-scan-history.tsv. Output: Tier2/module13-Foundit/ (md+xlsx+json).

import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HISTORY = "data/foundit-scan-history.tsv";
const RP = reportPaths();
const MOD = RP.mod(2, "module13-Foundit");
const STATUS = MOD.md("module13-Foundit.md");
const XLSX_OUT = MOD.xlsx("module13-Foundit.xlsx");
const JSON_OUT = MOD.json("module13-Foundit.json");

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const MAX = parseInt(positional.find((a) => /^\d+$/.test(a)) || "30", 10);
const EXP_MAX = 4; // below-4-yr band (per user)

const DEVOPS_TITLE =
  /dev[\s-]?(sec[\s-]?)?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release|kubernetes|\bk8s\b/i;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
// Exact phrase "devops engineer"; the Referer header is what makes the middleware API answer.
const API = (start) =>
  `https://www.foundit.in/middleware/jobsearch?start=${start}&sort=1&limit=40&query=${encodeURIComponent('"devops engineer"')}&locations=india&queryDerived=true`;

function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

async function fetchPage(start) {
  const r = await fetch(API(start), {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.foundit.in/search/devops-engineer-jobs-in-india",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// minimumExperience/maximumExperience are {years:N}. Below-4 rule: drop floor >= 4.
function fitsBand(j) {
  const lo = (j.minimumExperience && j.minimumExperience.years) || 0;
  const hi = (j.maximumExperience && j.maximumExperience.years) || lo;
  if (!lo && !hi) return { fit: true, reason: "exp unknown (kept)" };
  if (lo >= EXP_MAX) return { fit: false, reason: `${lo}-${hi} yrs (needs 4+)` };
  return { fit: true, reason: `${lo}-${hi} yrs (<4 ok)` };
}

mkdirSync("data", { recursive: true });
const seen = loadHistory();
const jobs = [];
const skipped = [];
const errors = [];

try {
  for (let start = 0; start < 80 && jobs.length < MAX; start += 40) {
    let data;
    try { data = await fetchPage(start); } catch (e) { errors.push(`start=${start}: ${e.message}`); break; }
    const rows = (data.jobSearchResponse && data.jobSearchResponse.data) || [];
    console.error(`  — page @${start}: ${rows.length} jobs`);
    if (!rows.length) break;
    for (const j of rows) {
      if (jobs.length >= MAX) break;
      const id = String(j.jobId || j.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = (j.title || "").replace(/\s+/g, " ").trim();
      const company = (j.companyName || "").replace(/\s+/g, " ").trim() || "—";
      const location = (j.locations || "").replace(/\s+/g, " ").trim() || "India";
      if (!title) continue;
      if (/\bintern(ship)?\b/i.test(title)) { skipped.push(`${company} — ${title} (internship)`); continue; }
      if (!DEVOPS_TITLE.test(title)) { skipped.push(`${company} — ${title} (not DevOps family)`); continue; }
      const band = fitsBand(j);
      if (!band.fit) { skipped.push(`${company} — ${title} (${band.reason})`); continue; }
      const url = j.seoJdUrl ? "https://www.foundit.in" + j.seoJdUrl : (j.jdUrl || j.redirectUrl || "");
      jobs.push({ id, title, company, location, posted: "", url, apply_url: url, exp: band.reason, skills: (j.skills || []).slice(0, 8) });
      console.error(`  [${jobs.length}] ${company} — ${title}  ·  ${band.reason}  ·  ${location}`);
    }
  }
} catch (e) {
  errors.push(e.message);
  console.error("⚠️ ", e.message);
}

// ---------- WRITE ----------
const now = new Date().toISOString();
const jsonStr = JSON.stringify({ scanned_at: now, source: "foundit", tier: 2, module: "module13-Foundit", filter: '"devops engineer" India below-4yr', errors, count: jobs.length, jobs }, null, 2);
writeFileSync("data/foundit-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# Foundit Scan — ${now.slice(0, 10)}\n\nFilter: DevOps family · India · below 4 yr\n${errors.length ? `\n> ⚠️ errors: ${errors.join("; ")}\n` : ""}\n${jobs.length} new in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Location:** ${j.location}\n- **Experience:** ${j.exp}\n- **Skills:** ${(j.skills || []).join(", ")}\n- **JD link:** ${j.url}\n\n_(open the link for the JD)_\n\n---\n\n`;
}
writeFileSync("data/foundit-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 13 — Foundit Job Scan (Tier 2)\n\n" +
    "Zero-token API scan of Foundit India (ex-Monster). Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (errors.length && jobs.length === 0) content += `| ${slot} | Foundit | _(fetch error)_ | — | — | — | — | — | — | ❌ err |\n`;
  else if (jobs.length === 0) content += `| ${slot} | Foundit | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | Foundit | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped (first 15):\n   - ` + skipped.slice(0, 15).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band Foundit jobs -> Tier2/module13-Foundit/`);
if (process.platform === "darwin") {
  const msg = jobs.length > 0 ? `${jobs.length} new Foundit DevOps job(s). Open Claude: "process the scan"` : "No new Foundit jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · Foundit scan" sound name "Glass"`]);
}
process.exit(0);
