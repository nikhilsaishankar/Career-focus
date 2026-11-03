#!/usr/bin/env node
// ingest-jobs.mjs — append pre-fetched jobs (Apple, SuccessFactors, web-search finds) into
// data/websearch-scan.json using the SAME filter chain as joindevops-sweep.mjs.
// Usage: node scripts/scan/ingest-jobs.mjs <jobs.json>   (file = {jobs:[...]} or [...])
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { expFloor, bodyExpFloor, sheetAdmits } from "../lib/job-filters.mjs";

const OUT = "data/websearch-scan.json";
const HISTORY = "data/websearch-scan-history.tsv";
const TODAY = new Date().toISOString().slice(0, 10);
const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra)|release\s*eng|build\s*(and|&)\s*release/i;
const INTERN = /\bintern(ship)?\b|\btrainee\b|\bfresher\b/i;
const INDIA = /india|hyderabad|bengaluru|bangalore|pune|chennai|mumbai|noida|gurugram|gurgaon|delhi|kolkata|ahmedabad|kochi|coimbatore/i;

const src = JSON.parse(readFileSync(process.argv[2], "utf8"));
const incoming = Array.isArray(src) ? src : src.jobs || [];
const data = JSON.parse(readFileSync(OUT, "utf8"));
const seen = new Set(readFileSync(HISTORY, "utf8").split("\n").map((l) => l.split("\t")[0]).filter(Boolean));
for (const j of data.jobs) seen.add(String(j.id));

let kept = 0, rejected = 0, dup = 0;
const notes = [];
for (const raw of incoming) {
  const job = { ...raw };
  const title = String(job.title || ""), company = String(job.company || ""), jd = String(job.jd || "");
  if (seen.has(String(job.id))) { dup++; continue; }
  if (!DEVOPS_TITLE.test(title)) { rejected++; notes.push(`x ${title} - not DevOps-family`); continue; }
  if (INTERN.test(title)) { rejected++; notes.push(`x ${title} - internship/trainee`); continue; }
  if (!INDIA.test(String(job.location || "") + " " + jd.slice(0, 400))) { rejected++; notes.push(`x ${title} - not India (${job.location})`); continue; }
  const floor = expFloor(title) ?? bodyExpFloor(jd);
  job.exp_floor = floor;
  if (floor != null && floor > 4) { rejected++; notes.push(`x ${title} - exp floor ${floor}y`); continue; }
  if (!sheetAdmits(job, 4)) { rejected++; notes.push(`x ${title} - gate reject`); continue; }
  data.jobs.push(job);
  seen.add(String(job.id));
  appendFileSync(HISTORY, `${job.id}\t${TODAY}\t${company}\t${title}\n`);
  kept++;
  notes.push(`+ ${company} - ${title} (${job.location}) floor=${floor} id=${job.id}`);
}
data.scanned_at = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(data, null, 2));
console.log(`kept ${kept}, rejected ${rejected}, already-seen ${dup}`);
console.log(notes.join("\n"));
