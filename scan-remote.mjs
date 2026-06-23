#!/usr/bin/env node
// scan-remote.mjs — zero-token scanner for the public remote-job boards:
//   RemoteOK · Remotive · Himalayas · WeWorkRemotely (RSS)
//
// These four expose public JSON/RSS — no login, no browser, zero Claude tokens.
// All are remote-first, so "India-wide" here means India-eligible remote: we keep
// worldwide + India + APAC + "anywhere" postings (a remote role you can do from India)
// and drop ones explicitly fenced to other regions (US-only / EU-only / Americas).
//
//   node scan-remote.mjs            # scan all four, default cap 40 total
//   node scan-remote.mjs 15         # cap total new jobs at 15
//   node scan-remote.mjs --source remoteok   # one board only
//
// Filter: DevOps family titles, internships dropped, deduped via
// data/remote-scan-history.tsv. Output: Tier2/module07-Remote/ (md+xlsx+json)
// plus data/remote-scan.{json,md}.

import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPaths } from "./reports-paths.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HISTORY = "data/remote-scan-history.tsv";
const RP = reportPaths();
const MOD = RP.mod(2, "module07-Remote");
const STATUS = MOD.md("module07-Remote.md");
const XLSX_OUT = MOD.xlsx("module07-Remote.xlsx");
const JSON_OUT = MOD.json("module07-Remote.json");

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const MAX = parseInt(positional.find((a) => /^\d+$/.test(a)) || "40", 10);
const ONLY = (args.find((a) => a.startsWith("--source")) || "").split("=")[1] ||
  (args.includes("--source") ? args[args.indexOf("--source") + 1] : null);

const DEVOPS_TITLE =
  /dev[\s-]?(sec[\s-]?)?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release|kubernetes|\bk8s\b/i;

// Region gate: keep remote roles an India-based candidate can actually take.
const KEEP_REGION = /worldwide|anywhere|global|india|apac|asia|emea|remote/i;
const DROP_REGION = /\b(usa?|united states|us[\s-]?only|us\s*based|canada|americas|latam|emea[\s-]?only|europe[\s-]?only|eu[\s-]?only|uk[\s-]?only)\b/i;

const UA = "career-ops-scan (https://github.com/santifer; contact via Remote OK source link)";

function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.text();
}

const clean = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
const regionOk = (loc) => {
  const t = (loc || "").toLowerCase();
  if (!t) return true; // unknown region on a remote board = keep (most are worldwide)
  if (DROP_REGION.test(t) && !/india|worldwide|anywhere|global|apac/i.test(t)) return false;
  return KEEP_REGION.test(t) || !DROP_REGION.test(t);
};

// ── Sources ──────────────────────────────────────────────────────────
async function fromRemoteOK() {
  const arr = await getJSON("https://remoteok.com/api?tags=devops");
  const out = [];
  for (const j of arr) {
    if (!j || !j.id || !j.position) continue; // first element is the legal notice
    out.push({
      source: "RemoteOK", id: `remoteok:${j.id}`,
      title: clean(j.position), company: clean(j.company) || "—",
      location: clean(j.location) || "Remote", url: j.url || `https://remoteok.com/remote-jobs/${j.id}`,
      jd: clean(j.description).slice(0, 4000),
    });
  }
  return out;
}
async function fromRemotive() {
  const d = await getJSON("https://remotive.com/api/remote-jobs?category=software-dev&search=devops&limit=80");
  return (d.jobs || []).map((j) => ({
    source: "Remotive", id: `remotive:${j.id}`,
    title: clean(j.title), company: clean(j.company_name) || "—",
    location: clean(j.candidate_required_location) || "Remote", url: j.url,
    jd: clean(j.description).slice(0, 4000),
  }));
}
async function fromHimalayas() {
  const d = await getJSON("https://himalayas.app/jobs/api?limit=200");
  return (d.jobs || []).map((j) => ({
    source: "Himalayas", id: `himalayas:${j.guid || j.applicationLink || j.title}`,
    title: clean(j.title), company: clean(j.companyName) || "—",
    location: clean((j.locationRestrictions || []).join(", ")) || "Remote",
    url: j.applicationLink || (j.companySlug ? `https://himalayas.app/companies/${j.companySlug}/jobs` : "https://himalayas.app/jobs"),
    jd: clean(j.excerpt || j.description).slice(0, 4000),
  }));
}
async function fromWWR() {
  const xml = await getText("https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss");
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const grab = (tag) => {
      const mm = item.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
      return mm ? clean(mm[1]) : "";
    };
    const link = grab("link");
    const rawTitle = grab("title"); // "Company: Role"
    if (!rawTitle || !link) continue;
    const idx = rawTitle.indexOf(":");
    const company = idx > -1 ? rawTitle.slice(0, idx).trim() : "—";
    const title = idx > -1 ? rawTitle.slice(idx + 1).trim() : rawTitle;
    const region = grab("region") || grab("category");
    out.push({
      source: "WeWorkRemotely", id: `wwr:${link.split("/").filter(Boolean).pop()}`,
      title, company, location: region || "Remote", url: link, jd: grab("description").slice(0, 4000),
    });
  }
  return out;
}

const SOURCES = { remoteok: fromRemoteOK, remotive: fromRemotive, himalayas: fromHimalayas, wwr: fromWWR };

// ── Scan ─────────────────────────────────────────────────────────────
mkdirSync("data", { recursive: true });
const seen = loadHistory();
const jobs = [];
const skipped = [];
const errors = [];

const wanted = ONLY ? [ONLY.toLowerCase()] : Object.keys(SOURCES);
for (const key of wanted) {
  const fn = SOURCES[key];
  if (!fn) { console.error(`  unknown source: ${key}`); continue; }
  let rows = [];
  try {
    rows = await fn();
    console.error(`  — ${key}: ${rows.length} raw`);
  } catch (e) {
    errors.push(`${key}: ${e.message}`);
    console.error(`  ⚠️  ${key} failed: ${e.message}`);
    continue;
  }
  for (const c of rows) {
    if (jobs.length >= MAX) break;
    if (!c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (/\bintern(ship)?\b/i.test(c.title)) { skipped.push(`${c.company} — ${c.title} (internship)`); continue; }
    if (!DEVOPS_TITLE.test(c.title)) { skipped.push(`${c.company} — ${c.title} (not DevOps family)`); continue; }
    if (!regionOk(c.location)) { skipped.push(`${c.company} — ${c.title} (region: ${c.location})`); continue; }
    jobs.push(c);
    console.error(`  [${jobs.length}] ${c.source} · ${c.company} — ${c.title}  ·  ${c.location}`);
  }
}

// ── Write ────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const jsonStr = JSON.stringify(
  { scanned_at: now, source: "remote-boards", tier: 2, module: "module07-Remote",
    filter: "DevOps family · India-eligible remote", sources: wanted, errors, count: jobs.length, jobs }, null, 2);
writeFileSync("data/remote-scan.json", jsonStr);
writeFileSync(JSON_OUT, jsonStr);

let md = `# Remote Boards Scan — ${now.slice(0, 10)}\n\nFilter: DevOps family · India-eligible remote · sources: ${wanted.join(", ")}\n${errors.length ? `\n> ⚠️ errors: ${errors.join("; ")}\n` : ""}\n${jobs.length} new in-band jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n- **Source:** ${j.source}\n- **Location:** ${j.location}\n- **JD link:** ${j.url}\n\n${j.jd ? j.jd.slice(0, 3000) : "_(open the link for the JD)_"}\n\n---\n\n`;
}
writeFileSync("data/remote-scan.md", md);

const date = now.slice(0, 10);
for (const j of jobs) appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\t${j.source}\n`);

{
  const d = new Date();
  const slot = d.getHours() < 12 ? "🌅" : d.getHours() < 19 ? "☀️" : "🌙";
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 07 — Remote Boards Scan (Tier 2)\n\n" +
    "RemoteOK · Remotive · Himalayas · WeWorkRemotely. Zero-token public APIs. Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (jobs.length === 0) content += `| ${slot} | Remote | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  else for (const j of jobs) content += `| ${slot} | ${j.source} | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
  writeFileSync(STATUS, content);
  try { execFileSync(process.execPath, [join(SCRIPT_DIR, "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" }); } catch {}
}

if (skipped.length) console.error(`\n  ${skipped.length} out-of-band skipped (first 15):\n   - ` + skipped.slice(0, 15).join("\n   - "));
console.error(`\n✅ ${jobs.length} NEW in-band remote jobs -> Tier2/module07-Remote/`);
if (process.platform === "darwin") {
  const msg = jobs.length > 0 ? `${jobs.length} new remote DevOps job(s). Open Claude: "process the scan"` : "No new remote jobs today.";
  execFile("osascript", ["-e", `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · Remote scan" sound name "Glass"`]);
}
process.exit(0);
