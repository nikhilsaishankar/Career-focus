#!/usr/bin/env node
// scan-talent.mjs — scan in.talent.com (Neuvoo) for fresh DevOps-family roles in India.
//
// talent.com is curl-readable: the search page carries an ld+json ItemList of
// /view?id=... links, and each view page carries the JD plus (usually) the
// employer's OWN ATS link (smartrecruiters/greenhouse/lever/workday/...).
// That direct link is what we want for the sheet — not the aggregator URL.
//
//   node scripts/scan/scan-talent.mjs [maxJobs]
//
// Appends new fitting roles to data/websearch-scan.json, dedup via
// data/websearch-scan-history.tsv.

import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expFloor, bodyExpFloor, sheetAdmits } from "../lib/job-filters.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const HISTORY = "data/websearch-scan-history.tsv";
const OUT = "data/websearch-scan.json";
const MAX = parseInt(process.argv[2] || "25", 10);

const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra)|release\s*eng|build\s*(and|&)\s*release/i;

const QUERIES = [
  "devops+engineer", "site+reliability+engineer", "cloud+engineer",
  "platform+engineer", "aws+devops",
];

function get(url) {
  try {
    return execFileSync("curl", ["-sL", "-A", UA, "--max-time", "25", url], {
      encoding: "utf8", maxBuffer: 40 * 1024 * 1024,
    });
  } catch { return ""; }
}

function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

const ATS_RE = /https?:\/\/[a-z0-9.-]*(?:greenhouse|lever\.co|myworkdayjobs|smartrecruiters|ashbyhq|icims|taleo|successfactors|oraclecloud|zohorecruit|keka|darwinbox|phenompeople|eightfold|workable|recruitee|jazzhr|breezy|teamtailor)[a-z0-9.\/_?=&%#-]*/i;

function parseView(id) {
  const html = get(`https://in.talent.com/view?id=${id}`);
  if (!html) return null;
  const t = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  // "Title – Company – Job Location, ST"
  const parts = t.split(/\s[–—]\s/).map((s) => s.trim());
  const title = parts[0] || "";
  const company = parts[1] || "";
  const locRaw = (parts[2] || "").replace(/^Job\s+/i, "");
  const body = html.replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const ats = (html.match(ATS_RE) || [])[0] || "";
  return { id: `talent-${id}`, title, company, location: locRaw, jd: cleanJd(body).slice(0, 9000), ats };
}

// talent.com view pages append OTHER employers' "Promoted"/"Similar jobs" cards plus the
// site footer to the JD text. Left in, those cards donate their own experience floors and
// stacks to this req — the contamination that produced a false REJECT and a false 7-yr
// floor (2026-10-28). A one-off backfill cleaned 157 stored rows but the scanner kept
// writing raw bodies, so every new row re-contaminated; clean at WRITE time instead.
//
// "Similar jobs" is the true boundary (it precedes the first "Show more" in every sample).
// Never cut below 300 chars: a short JD whose only marker sits early would become a stub,
// and absence of text proves nothing to the gate.
const JD_TAIL =
  /Similar jobs|People also searched|Show more Last updated:|For job seekers Search jobs|Terms of Service Privacy Policy/g;
function cleanJd(body) {
  let cut = body.length;
  for (const m of body.matchAll(JD_TAIL)) {
    if (m.index >= 300 && m.index < cut) cut = m.index;
  }
  return body.slice(0, cut).trim();
}

const seen = loadHistory();
const today = new Date().toISOString().slice(0, 10);
const ids = new Set();

for (const q of QUERIES) {
  const html = get(`https://in.talent.com/jobs?k=${q}&l=India`);
  for (const m of html.matchAll(/\/view\?id=([A-Za-z0-9]+)/g)) ids.add(m[1]);
  if (ids.size > 160) break;
}
console.log(`talent.com: ${ids.size} ids from ${QUERIES.length} queries`);

const fresh = [...ids].filter((i) => !seen.has(`talent-${i}`));
console.log(`${fresh.length} not in history`);

const kept = [];
const rejected = [];
for (const id of fresh) {
  if (kept.length >= MAX) break;
  const j = parseView(id);
  if (!j || !j.title) continue;
  if (!DEVOPS_TITLE.test(j.title)) { rejected.push([j.title, "not devops family"]); continue; }
  if (/\bintern(ship)?\b/i.test(j.title)) { rejected.push([j.title, "internship"]); continue; }
  const floor = bodyExpFloor(j.jd) ?? expFloor(j.title);
  if (floor != null && floor > 4) { rejected.push([j.title, `exp floor ${floor}y`]); continue; }
  if (!/india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|delhi|noida|gurgaon|gurugram|kolkata|ahmedabad|remote|kochi|coimbatore|indore|jaipur|trivandrum|thiruvananthapuram|mysore|nagpur|chandigarh|bhubaneswar|vadodara|surat|nashik|visakhapatnam|vizag/i.test(`${j.location} ${j.jd.slice(0, 1200)}`)) {
    rejected.push([j.title, `loc ${j.location}`]); continue;
  }
  const url = j.ats || `https://in.talent.com/view?id=${id}`;
  const source = j.ats ? (j.ats.match(/https?:\/\/([a-z0-9.-]+)/i) || [])[1] : "talent.com";
  kept.push({
    id: j.id, title: j.title, company: j.company, location: j.location || "India",
    url, source: j.ats ? source : "talent.com", discovered_via: "talent.com",
    jd: j.jd, exp_floor: floor,
  });
  process.stdout.write(".");
}
console.log(`\nkept ${kept.length}, rejected ${rejected.length}`);
rejected.slice(0, 12).forEach(([t, r]) => console.log(`  ✗ ${t} — ${r}`));

if (!kept.length) process.exit(0);

const data = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { scanned_at: "", jobs: [] };
const have = new Set((data.jobs || []).map((j) => j.id));
const add = kept.filter((j) => !have.has(j.id));
data.jobs = (data.jobs || []).concat(add);
data.scanned_at = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(data, null, 2));
appendFileSync(HISTORY, add.map((j) => `${j.id}\t${today}\t${j.company}\t${j.title}`).join("\n") + "\n");
console.log(`+${add.length} appended to ${OUT}`);
add.forEach((j) => console.log(`  ✓ ${j.company} — ${j.title} (${j.location}) [${j.source}]`));
