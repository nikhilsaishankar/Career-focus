#!/usr/bin/env node
// accumulate.mjs — keep every portal's FULL job set in its scan JSON across runs.
//
// Problem it solves: scanners dedup against a history TSV, so a re-run returns only *new*
// jobs and overwrites data/<x>-scan.json — making most portals look empty in the workbook.
// This syncs each data/<x>-scan.json with a durable sidecar (data/.pool/<x>.json): the union
// of all jobs ever seen, with processed fields (ATS, applied, status…) preserved. Run it after
// scanning (to pull the accumulated set back into the scan JSON) and after processing/applying
// (to push the new results into the sidecar). It's idempotent — safe to run anytime.
//
//   node accumulate.mjs
//
// After it runs, every portal's scan JSON holds its complete current set → the workbook shows
// all portals populated, and applied/scored jobs never disappear on the next scan.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";

const POOL = "data/.pool";
mkdirSync(POOL, { recursive: true });

const PROCESSED = ["ats", "jdFit", "pass", "insight", "resume", "status", "applied", "applied_at", "questions", "processed_at"];
const hasProcessed = (j) => j && j.ats != null;

function merge(aJobs, bJobs) {
  const byId = new Map();
  const key = (j) => String(j.id ?? j.jobId ?? `${j.company}|${j.title || j.role}`);
  for (const j of [...(aJobs || []), ...(bJobs || [])]) {
    const k = key(j);
    const prev = byId.get(k);
    if (!prev) { byId.set(k, { ...j }); continue; }
    // union: keep raw fields from whichever, but let processed fields win (don't lose ATS/applied)
    const merged = { ...prev, ...j };
    for (const f of PROCESSED) {
      if (j[f] === undefined && prev[f] !== undefined) merged[f] = prev[f];
      // if both have it, the one that actually carries a score/applied wins
      if (hasProcessed(prev) && !hasProcessed(j)) merged[f] = prev[f] !== undefined ? prev[f] : merged[f];
    }
    byId.set(k, merged);
  }
  return [...byId.values()];
}

let synced = 0;
for (const f of readdirSync("data").filter((x) => /-scan\.json$/.test(x))) {
  const scanPath = `data/${f}`;
  const poolPath = `${POOL}/${f}`;
  let scan, pool;
  try { scan = JSON.parse(readFileSync(scanPath, "utf8")); } catch { continue; }
  try { pool = existsSync(poolPath) ? JSON.parse(readFileSync(poolPath, "utf8")) : { jobs: [] }; } catch { pool = { jobs: [] }; }

  const mergedJobs = merge(pool.jobs, scan.jobs);
  const out = { ...scan, count: mergedJobs.length, jobs: mergedJobs };
  // write the full accumulated set to BOTH the scan JSON (downstream reads this) and the sidecar.
  writeFileSync(scanPath, JSON.stringify(out, null, 2));
  writeFileSync(poolPath, JSON.stringify(out, null, 2));
  synced++;
  console.error(`  ${f.replace("-scan.json", "").padEnd(14)} ${mergedJobs.length} total jobs`);
}
console.error(`\n✅ accumulated ${synced} portals — every scan JSON now holds its full set.`);
process.exit(0);
