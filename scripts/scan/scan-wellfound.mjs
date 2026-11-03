#!/usr/bin/env node
// scan-wellfound.mjs — scan wellfound.com (ex-AngelList) for fresh DevOps-family India roles.
//
// The SEO role+location landing pages are plain curl-readable: __NEXT_DATA__ carries an
// Apollo cache where every JobListingSearchResult holds title, slug, locationNames,
// liveStartAt, the full description AND yearsExperienceMin — so the <=4yr band is read
// from a structured field instead of being guessed off the title. Company names come from
// the sibling StartupResult entries (joined via highlightedJobListings refs).
//
//   https://wellfound.com/role/l/<role-slug>/india?page=N
//
//   node scripts/scan/scan-wellfound.mjs [maxJobs]
//
// Appends new fitting roles to data/websearch-scan.json, dedup via
// data/websearch-scan-history.tsv.

import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expFloor, bodyExpFloor } from "../lib/job-filters.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const HISTORY = "data/websearch-scan-history.tsv";
const OUT = "data/websearch-scan.json";
const MAX = parseInt(process.argv[2] || "40", 10);

const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra)|release\s*eng|build\s*(and|&)\s*release/i;
const INTERN = /\bintern(ship)?\b|\btrainee\b|\bfresher\b/i;
const INDIA =
  /india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|delhi|noida|gurgaon|gurugram|kolkata|ahmedabad|kochi|coimbatore|indore|jaipur|trivandrum|thiruvananthapuram|mysore|nagpur|chandigarh|bhubaneswar|vadodara|surat|nashik|visakhapatnam|vizag|karnataka|maharashtra|telangana|tamil\s*nadu|kerala|gujarat|rajasthan|punjab|haryana|uttar\s*pradesh|west\s*bengal|andhra\s*pradesh|odisha|madhya\s*pradesh|goa|assam|bihar|jharkhand|chhattisgarh|uttarakhand|himachal|connaught\s*place|hinjewadi|whitefield|powai|andheri|gachibowli|electronic\s*city/i;

const ROLES = ["devops-engineer", "site-reliability-engineer", "platform-engineer", "cloud-engineer", "infrastructure-engineer"];
const PAGES = 3;

function get(url) {
  try {
    return execFileSync("curl", ["-sL", "-A", UA, "--max-time", "30", url], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return ""; }
}

function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[0]));
}

const strip = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&")
  .replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

// Pull every job out of one landing page, resolving its company via the StartupResult that
// references it. The listing itself carries no company field — only the startup does.
function parsePage(html) {
  const m = html.match(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let st;
  try { st = JSON.parse(m[1]).props.pageProps.apolloState.data; } catch { return []; }

  const companyOf = new Map();
  for (const [k, v] of Object.entries(st)) {
    if (!k.startsWith("StartupResult:")) continue;
    for (const ref of v.highlightedJobListings || []) {
      if (ref?.__ref) companyOf.set(ref.__ref, v.name || "");
    }
  }

  const out = [];
  for (const [k, v] of Object.entries(st)) {
    if (!k.startsWith("JobListingSearchResult:")) continue;
    out.push({
      id: `wellfound-${v.id}`,
      title: strip(v.title),
      company: companyOf.get(k) || "",
      location: (v.locationNames || []).join(", ") || (v.remote ? "Remote" : ""),
      url: `https://wellfound.com/jobs/${v.id}-${v.slug || ""}`.replace(/-$/, ""),
      source: "Wellfound",
      discovered_via: "wellfound",
      jd: strip(v.description).slice(0, 9000),
      exp_min: v.yearsExperienceMin,
      posted: v.liveStartAt ? new Date(v.liveStartAt * 1000).toISOString().slice(0, 10) : "",
    });
  }
  return out;
}

const seen = loadHistory();
const today = new Date().toISOString().slice(0, 10);

const cands = new Map();
for (const role of ROLES) {
  for (let p = 1; p <= PAGES; p++) {
    const url = `https://wellfound.com/role/l/${role}/india${p > 1 ? `?page=${p}` : ""}`;
    const jobs = parsePage(get(url));
    for (const j of jobs) if (!cands.has(j.id)) cands.set(j.id, j);
    if (!jobs.length) break;
  }
}
console.log(`wellfound: ${cands.size} candidates across ${ROLES.length} roles`);

const fresh = [...cands.values()].filter((j) => !seen.has(j.id));
console.log(`${fresh.length} not in history`);

const kept = [];
const rejected = [];
for (const j of fresh) {
  if (kept.length >= MAX) break;
  if (!j.title || !DEVOPS_TITLE.test(j.title)) { rejected.push([j.title, "not devops family"]); continue; }
  if (INTERN.test(j.title)) { rejected.push([j.title, "internship"]); continue; }
  if (!INDIA.test(`${j.location} ${j.jd.slice(0, 1500)}`)) { rejected.push([j.title, `loc ${j.location}`]); continue; }
  // Wellfound's own structured minimum wins; fall back to the JD body, then the title grade.
  const floor = j.exp_min != null ? Number(j.exp_min) : (bodyExpFloor(j.jd) ?? expFloor(j.title));
  if (floor != null && floor > 4) { rejected.push([j.title, `exp floor ${floor}y`]); continue; }
  delete j.exp_min;
  kept.push({ ...j, exp_floor: floor });
  process.stdout.write(".");
}
console.log(`\nkept ${kept.length}, rejected ${rejected.length}`);
rejected.slice(0, Number(process.env.WF_SHOW || 12)).forEach(([t, r]) => console.log(`  ✗ ${t} — ${r}`));

if (!kept.length) process.exit(0);

const data = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { scanned_at: "", jobs: [] };
const have = new Set((data.jobs || []).map((j) => j.id));
const add = kept.filter((j) => !have.has(j.id));
data.jobs = (data.jobs || []).concat(add);
data.scanned_at = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(data, null, 2));
appendFileSync(HISTORY, add.map((j) => `${j.id}\t${today}\t${j.company}\t${j.title}`).join("\n") + "\n");
console.log(`+${add.length} appended to ${OUT}`);
add.forEach((j) => console.log(`  ✓ ${j.company} — ${j.title} (${j.location}) [floor ${j.exp_floor ?? "?"}y]`));
