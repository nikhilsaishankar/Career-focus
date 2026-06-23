#!/usr/bin/env node
// set-job-result.mjs — write a processed result (JD fit, ATS, insight, résumé, status) back
// into a job inside a data/*-scan.json, so build-workbook.mjs can render the filled funnel.
//
// Usage:
//   node set-job-result.mjs <scanFile> <jobId> key=value [key=value ...]
// Recognized keys: jdFit  ats  pass  insight  resume  status
// Examples:
//   node set-job-result.mjs data/foundit-scan.json 56597434 \
//        jdFit=✅ ats=82 pass=true status="🟢 Ready" insight="Strong AWS/K8s match — apply" \
//        resume=/Users/nikhil_kotharu/Documents/profile/Nikhil_DevOps_Siemens.pdf
//
// pass accepts true/false. ats accepts a number (82) or string (82%). Unknown keys are ignored.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [scanFile, jobId, ...pairs] = process.argv.slice(2);
if (!scanFile || !jobId || pairs.length === 0) {
  console.error("usage: node set-job-result.mjs <scanFile> <jobId> key=value ...");
  process.exit(1);
}
if (!existsSync(scanFile)) { console.error(`✗ ${scanFile} not found`); process.exit(1); }

const ALLOWED = new Set(["jdFit", "ats", "pass", "insight", "resume", "status"]);
const updates = {};
for (const p of pairs) {
  const i = p.indexOf("=");
  if (i < 0) continue;
  const k = p.slice(0, i);
  let v = p.slice(i + 1);
  if (!ALLOWED.has(k)) continue;
  if (k === "pass") v = /^(true|1|yes|y)$/i.test(v);
  else if (k === "ats") { const n = parseFloat(String(v).replace("%", "")); v = Number.isFinite(n) ? n : v; }
  updates[k] = v;
}

const data = JSON.parse(readFileSync(scanFile, "utf8"));
const jobs = data.jobs || [];
const job = jobs.find((j) => String(j.id) === String(jobId) || String(j.jobId) === String(jobId));
if (!job) { console.error(`✗ job ${jobId} not found in ${scanFile}`); process.exit(2); }

Object.assign(job, updates);
job.processed_at = new Date().toISOString();
writeFileSync(scanFile, JSON.stringify(data, null, 2));
console.error(`✅ ${scanFile} · job ${jobId} ← ${Object.keys(updates).join(", ")}`);
