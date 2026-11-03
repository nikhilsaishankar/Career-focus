#!/usr/bin/env node
// jobfound-sweep.mjs — enumerate jobfound.org's DevOps domain feed and stage
// fresh in-band India candidates for STEP 2 processing.
//
//   node scripts/scan/jobfound-sweep.mjs [out.json]
//
// Dedupes against data/websearch-scan-history.tsv (by jobfound $id) AND against
// the LinkedIn ids already in data/devops-scan.json (applyUrl is a LI repost).
// Writes candidates only — scoring/link-resolution happen downstream.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const OUT = process.argv[2] || "/tmp/jobfound-candidates.json";
const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra)|release\s*eng|build\s*(and|&)\s*release/i;
const INTERN = /intern(ship)?\b|trainee|fresher\s*only|apprentice/i;

const get = (url) => {
  try {
    return execFileSync("curl", ["-sL", "-A", UA, "--max-time", "30", url],
      { encoding: "utf8", maxBuffer: 40 * 1024 * 1024 });
  } catch { return ""; }
};

const seen = new Set();
if (existsSync("data/websearch-scan-history.tsv")) {
  for (const line of readFileSync("data/websearch-scan-history.tsv", "utf8").split("\n")) {
    const id = line.split("\t")[0];
    if (id) { seen.add(id); seen.add(id.replace(/^jobfound-/, "")); }
  }
}
const liSeen = new Set();
for (const f of ["data/devops-scan.json", "data/websearch-scan.json"]) {
  if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, "utf8"));
  for (const j of d.jobs || []) {
    if (/^\d{10}$/.test(j.id)) liSeen.add(j.id);
    const m = String(j.url || "").match(/linkedin\.com\/jobs\/view\/[^?]*?(\d{10})/);
    if (m) liSeen.add(m[1]);
  }
}

const rows = [];
for (let page = 1; page <= 8; page++) {
  const raw = get(`https://jobfound.org/api/jobs?domain=DevOps&limit=100&page=${page}`);
  let d; try { d = JSON.parse(raw); } catch { break; }
  const jobs = d.jobs || [];
  rows.push(...jobs);
  process.stderr.write(`page ${page}: ${jobs.length} (total ${d.total})\n`);
  if (!d.hasMore || !jobs.length) break;
}

const out = [];
let skipSeen = 0, skipLoc = 0, skipTitle = 0, skipExp = 0, skipLi = 0;
for (const j of rows) {
  const id = j["$id"];
  if (!id) continue;
  if (seen.has(id) || seen.has("jobfound-" + id)) { skipSeen++; continue; }
  const loc = `${j.location || ""} ${j.country || ""}`;
  if (!/india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|gurugram|gurgaon|noida|delhi|kolkata|ahmedabad|remote/i.test(loc)) { skipLoc++; continue; }
  if (!DEVOPS_TITLE.test(j.title || "")) { skipTitle++; continue; }
  if (INTERN.test(j.title || "")) { skipTitle++; continue; }
  const exp = parseFloat(j.experience);
  // experience "0" = NOT STATED (per memory) -> keep, grep the body later
  if (Number.isFinite(exp) && exp > 4) { skipExp++; continue; }
  const apply = String(j.applyUrl || "").replace(/[?&]source=jobfound\.org/, "");
  const li = apply.match(/linkedin\.com\/jobs\/view\/[^?]*?(\d{10})/);
  if (li && liSeen.has(li[1])) { skipLi++; continue; }
  out.push({
    id: "jobfound-" + id, title: j.title, company: j.companyName,
    location: j.location || j.country, url: apply,
    experience: j.experience, workplaceType: j.workplaceType,
    postedAt: j.postedAt, teaser: j.description,
  });
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`fetched ${rows.length} rows -> ${out.length} candidates (seen ${skipSeen}, loc ${skipLoc}, title ${skipTitle}, exp>4 ${skipExp}, li-dup ${skipLi})`);
console.log(`wrote ${OUT}`);
