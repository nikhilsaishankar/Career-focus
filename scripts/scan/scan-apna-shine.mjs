#!/usr/bin/env node
// scan-apna-shine.mjs — scan apna.co and shine.com for fresh DevOps-family roles in India.
//
// Both boards are curl-readable with a browser UA (no JS wall, no login). Recipes:
//   apna  — https://apna.co/jobs/<role>-jobs-in-<CITY>?page=N  (city slug is mandatory;
//           "-in-india" is NOT a slug and 404s). Job page carries ld+json JobPosting.
//   shine — https://www.shine.com/job-search/<role>-jobs?q=<role>&experience=N  (the
//           documented ?q= form; the bare "-jobs-in-india" variant yields zero hrefs).
//           Job page carries ld+json JobPosting.
//
//   node scripts/scan/scan-apna-shine.mjs [maxJobs]
//
// Appends new fitting roles to data/websearch-scan.json, dedup via
// data/websearch-scan-history.tsv.

import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expFloor, bodyExpFloor, sheetAdmits } from "../lib/job-filters.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const HISTORY = "data/websearch-scan-history.tsv";
const OUT = "data/websearch-scan.json";
const MAX = parseInt(process.argv[2] || "25", 10);
const TODAY = new Date().toISOString().slice(0, 10);

const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra)|release\s*eng|build\s*(and|&)\s*release/i;
const INTERN = /\bintern(ship)?\b|\btrainee\b|\bfresher\b/i;

const APNA_CITIES = ["hyderabad", "bengaluru", "pune", "chennai", "mumbai", "noida"];
const APNA_ROLES = ["devops-engineer", "cloud-engineer"];
const SHINE_ROLES = ["devops-engineer", "site-reliability-engineer", "cloud-engineer", "platform-engineer"];

const curl = (url) => {
  try {
    return execFileSync("curl", ["-s", "-L", "-A", UA, "--max-time", "30", url], {
      maxBuffer: 1 << 27,
    }).toString();
  } catch {
    return "";
  }
};

const strip = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// Pull every ld+json JobPosting object out of a job page.
function jobPosting(html) {
  for (const m of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  )) {
    let d;
    try {
      d = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    for (const node of Array.isArray(d) ? d : [d]) {
      if (node && node["@type"] === "JobPosting") return node;
    }
  }
  return null;
}

function locationOf(p) {
  const l = p.jobLocation;
  const one = Array.isArray(l) ? l[0] : l;
  const a = one?.address || {};
  return [a.addressLocality, a.addressRegion].filter(Boolean).join(", ") || "India";
}

// ---- collect candidate (id, url) pairs -------------------------------------
const candidates = [];
const seenUrl = new Set();

for (const role of APNA_ROLES) {
  for (const city of APNA_CITIES) {
    for (let page = 1; page <= 2; page++) {
      const html = curl(`https://apna.co/jobs/${role}-jobs-in-${city}?page=${page}`);
      if (!html) continue;
      const ids = new Set([...html.matchAll(/href="\/job\/(\d+)"/g)].map((m) => m[1]));
      for (const id of ids) {
        const url = `https://apna.co/job/${id}`;
        if (seenUrl.has(url)) continue;
        seenUrl.add(url);
        candidates.push({ id: `apna-${id}`, url, source: "Apna", via: "apna" });
      }
    }
  }
}

for (const role of SHINE_ROLES) {
  for (const exp of [3, 4]) {
    const html = curl(
      `https://www.shine.com/job-search/${role}-jobs?q=${role}&experience=${exp}`
    );
    if (!html) continue;
    const urls = new Set(
      [...html.matchAll(/https:\/\/www\.shine\.com\/jobs\/[A-Za-z0-9._/-]+\/(\d+)/g)].map(
        (m) => m[0]
      )
    );
    for (const url of urls) {
      if (seenUrl.has(url)) continue;
      seenUrl.add(url);
      candidates.push({
        id: `shine-${url.match(/\/(\d+)$/)[1]}`,
        url,
        source: "Shine",
        via: "shine",
      });
    }
  }
}

const hist = readFileSync(HISTORY, "utf8");
const data = JSON.parse(readFileSync(OUT, "utf8"));
const haveId = new Set(data.jobs.map((j) => j.id));
const fresh = candidates.filter((c) => !haveId.has(c.id) && !hist.includes(c.id));
console.log(
  `${candidates.length} candidates (apna ${candidates.filter((c) => c.via === "apna").length}, shine ${candidates.filter((c) => c.via === "shine").length}) · ${fresh.length} not in history`
);

// ---- fetch each job page, filter, append ----------------------------------
const kept = [];
const rejected = [];
for (const c of fresh) {
  if (kept.length >= MAX) break;
  const html = curl(c.url);
  if (!html) continue;
  const p = jobPosting(html);
  if (!p) continue;
  const title = strip(p.title);
  const company = strip(p.hiringOrganization?.name) || "Unknown";
  if (!DEVOPS_TITLE.test(title)) continue;
  if (INTERN.test(title)) {
    rejected.push(`${title} — internship/fresher`);
    continue;
  }
  if (p.validThrough && p.validThrough.slice(0, 10) < TODAY) {
    rejected.push(`${title} — expired ${p.validThrough.slice(0, 10)}`);
    continue;
  }
  const jd = strip(p.description);
  if (jd.length < 200) continue;
  const months = p.experienceRequirements?.monthsOfExperience;
  const monthFloor = months ? Math.floor(Number(months) / 12) : null;
  const floor = bodyExpFloor(jd) ?? monthFloor ?? expFloor(title);
  if (floor !== null && floor > 4) {
    rejected.push(`${title} — exp floor ${floor}y`);
    continue;
  }
  const job = {
    id: c.id,
    title,
    company,
    location: locationOf(p),
    url: c.url,
    source: c.source,
    discovered_via: c.via,
    jd,
  };
  if (!sheetAdmits(job)) {
    rejected.push(`${title} — gate reject`);
    continue;
  }
  kept.push(job);
  process.stdout.write(".");
}

console.log(`\nkept ${kept.length}, rejected ${rejected.length}`);
for (const r of rejected.slice(0, 15)) console.log("  ✗ " + r);

if (kept.length) {
  data.jobs.push(...kept);
  data.scanned_at = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(data, null, 2));
  for (const j of kept) {
    appendFileSync(HISTORY, `${j.id}\t${TODAY}\t${j.company}\t${j.title}\n`);
  }
  console.log(`+${kept.length} appended to ${OUT}`);
  for (const j of kept) {
    console.log(`  ✓ ${j.company} — ${j.title} (${j.location}) [${j.source}]`);
  }
} else {
  console.log("no new in-band jobs");
}
