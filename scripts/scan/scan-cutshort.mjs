#!/usr/bin/env node
// scan-cutshort.mjs — scan cutshort.io for fresh DevOps-family India roles.
//
// cutshort.io is curl-readable with a browser UA (no JS wall, no login). Recipe:
//   listing — https://cutshort.io/jobs/<skill>-jobs  returns 50 /job/<slug> hrefs.
//             ?page=N does NOT paginate (returns the same 50), so breadth comes from
//             sweeping several skill slugs instead of walking pages.
//   job     — https://cutshort.io/job/<slug>  carries an ld+json JobPosting whose
//             experienceRequirements.monthsOfExperience is a STRUCTURED exp floor —
//             preferred over title/body guessing — plus validThrough for liveness.
//
//   node scripts/scan/scan-cutshort.mjs [maxJobs]
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

const SLUGS = ["devops", "aws", "kubernetes", "docker", "jenkins", "terraform", "ci-cd", "linux"];

const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra)|release\s*eng|build\s*(and|&)\s*release/i;
const INTERN = /\bintern(ship)?\b|\btrainee\b|\bfresher\b/i;

const get = (u) => {
  try {
    return execFileSync("curl", ["-s", "-L", "-A", UA, "--max-time", "25", u], { maxBuffer: 1 << 26 }).toString();
  } catch { return ""; }
};
const strip = (h) => h.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

// ---- collect candidate slugs across skill listings
const slugs = new Set();
for (const s of SLUGS) {
  const html = get(`https://cutshort.io/jobs/${s}-jobs`);
  for (const m of html.matchAll(/\/job\/([A-Za-z0-9._-]+)/g)) slugs.add(m[1]);
}
console.log(`listing slugs: ${slugs.size}`);

const data = JSON.parse(readFileSync(OUT, "utf8"));
const seen = new Set(data.jobs.map((j) => j.id));
const histIds = new Set(
  readFileSync(HISTORY, "utf8").split("\n").map((l) => l.split("\t")[0]).filter(Boolean)
);

let kept = 0, rejected = 0, checked = 0;
const notes = [];

for (const slug of slugs) {
  if (kept >= MAX) break;
  const id = `cutshort-${slug.slice(-8)}`;
  if (seen.has(id) || histIds.has(id)) continue;

  // cheap title prefilter off the slug before spending a job-page fetch
  const slugWords = slug.replace(/-/g, " ");
  if (!DEVOPS_TITLE.test(slugWords)) { rejected++; continue; }

  checked++;
  const html = get(`https://cutshort.io/job/${slug}`);
  if (!html) { notes.push(`? ${slug} — fetch failed`); continue; }

  let post = null;
  for (const b of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const o = JSON.parse(b[1]);
      const cand = Array.isArray(o) ? o.find((x) => x["@type"] === "JobPosting") : o;
      if (cand && cand["@type"] === "JobPosting") { post = cand; break; }
    } catch { /* non-JSON ld block */ }
  }
  if (!post) { notes.push(`? ${slug} — no ld+json`); continue; }

  const title = strip(String(post.title || ""));
  const company = strip(String(post.hiringOrganization?.name || ""));
  const locs = [post.jobLocation].flat().filter(Boolean)
    .map((l) => [l.address?.addressLocality, l.address?.addressRegion, l.address?.addressCountry]
      .filter((x) => typeof x === "string").join(", "));
  const location = locs.filter(Boolean).join(" / ") || "";
  const jd = strip(String(post.description || ""));

  if (!DEVOPS_TITLE.test(title)) { rejected++; notes.push(`✗ ${title} — not DevOps-family`); continue; }
  if (INTERN.test(title)) { rejected++; notes.push(`✗ ${title} — internship/trainee`); continue; }
  if (post.validThrough && new Date(post.validThrough) < new Date()) {
    rejected++; notes.push(`✗ ${title} — expired ${String(post.validThrough).slice(0, 10)}`); continue;
  }
  if (!/india|hyderabad|bengaluru|bangalore|pune|chennai|mumbai|noida|gurugram|gurgaon|delhi|kolkata|ahmedabad|kochi|coimbatore|remote/i
        .test(location + " " + jd.slice(0, 400))) {
    rejected++; notes.push(`✗ ${title} — not India (${location})`); continue;
  }

  // Structured months field is the most reliable floor cutshort gives us; fall back
  // to the title/body heuristics the other scanners use when it is absent.
  const months = Number(post.experienceRequirements?.monthsOfExperience);
  const floor = Number.isFinite(months) && months > 0
    ? Math.round(months / 12)
    : (expFloor(title) ?? bodyExpFloor(jd));

  const job = {
    id, title, company, location,
    url: `https://cutshort.io/job/${slug}`,
    source: "cutshort", discovered_via: "cutshort",
    jd, exp_floor: floor,
  };

  if (floor != null && floor > 4) { rejected++; notes.push(`✗ ${title} — exp floor ${floor}y`); continue; }
  if (!sheetAdmits(job, 4)) { rejected++; notes.push(`✗ ${title} — gate reject`); continue; }

  data.jobs.push(job);
  seen.add(id);
  appendFileSync(HISTORY, `${id}\t${TODAY}\t${company}\t${title}\n`);
  kept++;
  notes.push(`✓ ${company} — ${title} (${location}) floor=${floor}`);
}

data.scanned_at = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(data, null, 2));
console.log(`fetched ${checked}, kept ${kept}, rejected ${rejected}`);
for (const n of notes) console.log("  " + n);
