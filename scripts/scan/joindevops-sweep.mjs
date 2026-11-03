#!/usr/bin/env node
// joindevops-sweep.mjs — one-pass sweep of jobs.joindevops.com for DevOps-family India roles.
//
// The board is curl-readable and every job page carries an ld+json JobPosting (title,
// hiringOrganization, jobLocation, validThrough, description). Takes a file of bare numeric
// job ids on stdin, fetches each, filters to the <=4yr DevOps band, and appends the keepers
// to data/websearch-scan.json (dedup via data/websearch-scan-history.tsv).
//
//   cut -d/ -f3 ids.txt | node scripts/scan/joindevops-sweep.mjs

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expFloor, bodyExpFloor, sheetAdmits } from "../lib/job-filters.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const OUT = "data/websearch-scan.json";
const HISTORY = "data/websearch-scan-history.tsv";
const TODAY = new Date().toISOString().slice(0, 10);

const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra)|release\s*eng|build\s*(and|&)\s*release/i;
const INTERN = /\bintern(ship)?\b|\btrainee\b|\bfresher\b/i;

const ids = readFileSync(0, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const data = JSON.parse(readFileSync(OUT, "utf8"));
const seen = new Set(data.jobs.map((j) => j.id));

const strip = (h) => h.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

let kept = 0, rejected = 0;
const notes = [];

for (const id of ids) {
  const slug = id;                       // accepts either "<id>" or "<id>-<slug>"
  const num = slug.split("-")[0];
  const url = `https://jobs.joindevops.com/jobs/${slug}`;
  let html = "";
  try {
    html = execFileSync("curl", ["-s", "-L", "-A", UA, "--max-time", "25", url], { maxBuffer: 1 << 26 }).toString();
  } catch { continue; }

  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)];
  let post = null;
  for (const b of blocks) {
    try {
      const o = JSON.parse(b[1]);
      const cand = Array.isArray(o) ? o.find((x) => x["@type"] === "JobPosting") : o;
      if (cand && cand["@type"] === "JobPosting") { post = cand; break; }
    } catch { /* non-JSON ld block */ }
  }
  if (!post) { notes.push(`? ${num} — no ld+json`); continue; }

  const title = strip(String(post.title || ""));
  const company = strip(String(post.hiringOrganization?.name || ""));
  const locs = [post.jobLocation].flat().filter(Boolean)
    .map((l) => [l.address?.addressLocality, l.address?.addressRegion, l.address?.addressCountry?.name || l.address?.addressCountry]
      .filter(Boolean).join(", "));
  const location = locs[0] || "";
  const jd = strip(String(post.description || ""));
  const job = { id: `joindevops-${num}`, title, company, location, url, source: "joindevops", discovered_via: "joindevops", jd };

  if (seen.has(job.id)) continue;
  if (!DEVOPS_TITLE.test(title)) { rejected++; notes.push(`✗ ${title} — not DevOps-family`); continue; }
  if (INTERN.test(title)) { rejected++; notes.push(`✗ ${title} — internship/trainee`); continue; }
  // An explicit non-India location in the structured field wins outright. Without this the
  // `remote` alternative below admits US reqs whose blurb merely says "remote" — it leaked
  // Gotham (White Plains NY), SAIC (Scott AFB IL) and ICON plc (Raleigh NC) in Oct 2026.
  if (/united states|,\s*(US|USA|UK|UAE|Canada|Australia|Singapore|Germany|Poland|Philippines)$|\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY),\s*United States/i.test(location)) {
    rejected++; notes.push(`✗ ${title} — non-India location (${location})`); continue;
  }
  if (!/india|hyderabad|bengaluru|bangalore|pune|chennai|mumbai|noida|gurugram|gurgaon|delhi|kolkata|ahmedabad|kochi|coimbatore|remote/i.test(location + " " + jd.slice(0, 400))) {
    rejected++; notes.push(`✗ ${title} — not India`); continue;
  }
  if (post.validThrough && new Date(post.validThrough) < new Date()) { rejected++; notes.push(`✗ ${title} — expired ${post.validThrough.slice(0,10)}`); continue; }

  const floor = expFloor(title) ?? bodyExpFloor(jd);
  job.exp_floor = floor;
  if (floor != null && floor > 4) { rejected++; notes.push(`✗ ${title} — exp floor ${floor}y`); continue; }
  if (!sheetAdmits(job, 4)) { rejected++; notes.push(`✗ ${title} — gate reject`); continue; }

  data.jobs.push(job);
  seen.add(job.id);
  appendFileSync(HISTORY, `${job.id}\t${TODAY}\t${company}\t${title}\n`);
  kept++;
  notes.push(`✓ ${company} — ${title} (${location}) floor=${floor}`);
}

data.scanned_at = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(data, null, 2));
console.log(`kept ${kept}, rejected ${rejected}`);
console.log(notes.join("\n"));
