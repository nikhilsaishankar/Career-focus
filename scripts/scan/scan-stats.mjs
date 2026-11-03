#!/usr/bin/env node
// scan-stats.mjs — cross-platform job-scan statistics with a LOCATION breakdown.
//
// Reads every data/*-scan.json the scanners emit (LinkedIn/Naukri/Instahyre/Hirist/
// Remote boards/SimplyHired), normalizes each posting's location to a canonical city,
// and aggregates: by location, by source, by role-family, plus remote vs onsite split.
//
//   node scan-stats.mjs            # print tables + write data/scan-stats.{md,json}
//   node scan-stats.mjs --json     # machine output only
//
// Zero tokens — pure aggregation over the scan JSON the other modules already wrote.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const JSON_ONLY = args.includes("--json");

// Map a raw location string -> { city, bucket }. bucket ∈ India | Remote | International.
const REMOTE = /remote|anywhere|worldwide|work\s*from\s*home|wfh|global/i;
// Canonical Indian metro aliases -> display name.
const CITY_ALIAS = [
  [/bengaluru|bangalore|bangalthere/i, "Bengaluru"],
  [/gurgaon|gurugram/i, "Gurgaon"],
  [/(new\s*)?delhi|ncr|noida|ghaziabad|faridabad/i, "Delhi-NCR"],
  [/mumbai|bombay|navi\s*mumbai|thane/i, "Mumbai"],
  [/hyderabad|secunderabad|telangana/i, "Hyderabad"],
  [/pune|hadapsar|maharashtra/i, "Pune"],
  [/chennai|madras|tamil\s*nadu/i, "Chennai"],
  [/kolkata|calcutta/i, "Kolkata"],
  [/ahmedabad|gujarat/i, "Ahmedabad"],
  [/kochi|cochin|kerala|kozhikode|nagercoil|trivandrum/i, "Kerala"],
  [/jaipur|rajasthan/i, "Jaipur"],
  [/indore|bhopal/i, "Indore/Bhopal"],
  [/chandigarh|mohali/i, "Chandigarh"],
  [/coimbatore/i, "Coimbatore"],
];
const INDIA_HINT = /india|karnataka|maharashtra|telangana|tamil\s*nadu|kerala|gujarat|rajasthan|punjab|haryana|uttar\s*pradesh|west\s*bengal|andhra|odisha|madhya\s*pradesh/i;

const titleCase = (s) =>
  s.replace(/[_]+/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();
function classify(rawLoc) {
  const loc = (rawLoc || "").trim();
  if (!loc || loc === "—") return { city: "Unspecified", bucket: "Unknown" };
  if (/multiple\s*location|various|several/i.test(loc)) return { city: "Multiple", bucket: "Multiple" };
  if (REMOTE.test(loc)) return { city: "Remote", bucket: "Remote" };
  for (const [re, name] of CITY_ALIAS) if (re.test(loc)) return { city: name, bucket: "India" };
  if (INDIA_HINT.test(loc)) return { city: titleCase(loc.split(",")[0]), bucket: "India" };
  // Not remote, not recognized India → treat as international; label by first segment.
  const head = titleCase(loc.split(",")[0]) || "International";
  return { city: head, bucket: "International" };
}

const ROLE_FAMILY = [
  [/\bsre\b|site\s*reliability/i, "SRE"],
  [/platform\s*eng/i, "Platform"],
  [/cloud/i, "Cloud"],
  [/infra/i, "Infrastructure"],
  [/dev[\s-]?sec[\s-]?ops/i, "DevSecOps"],
  [/dev[\s-]?ops/i, "DevOps"],
];
function family(title) {
  for (const [re, name] of ROLE_FAMILY) if (re.test(title || "")) return name;
  return "Other";
}

// Source label from the JSON's own field, else derived from the filename.
function sourceOf(file, data, job) {
  if (job.source) return job.source;
  if (data.source && data.source !== "remote-boards") return data.source;
  const m = file.match(/^([a-z]+)-scan\.json$/i);
  const map = { devops: "LinkedIn", naukri: "Naukri", instahyre: "Instahyre", hirist: "Hirist", simplyhired: "SimplyHired", remote: "RemoteBoards" };
  return map[(m && m[1]) || ""] || (m ? m[1] : "unknown");
}

// ── Collect ──────────────────────────────────────────────────────────
const files = existsSync("data") ? readdirSync("data").filter((f) => /-scan\.json$/.test(f)) : [];
const all = [];
const perSourceScanTime = {};
for (const f of files) {
  let data;
  try { data = JSON.parse(readFileSync(`data/${f}`, "utf8")); } catch { continue; }
  perSourceScanTime[f] = data.scanned_at || "";
  for (const j of data.jobs || []) {
    const src = sourceOf(f, data, j);
    const { city, bucket } = classify(j.location);
    all.push({ src, title: j.title || "", company: j.company || "", city, bucket, fam: family(j.title), location: j.location || "" });
  }
}

// ── Aggregate ────────────────────────────────────────────────────────
const tally = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const byLocation = tally(all, (r) => r.city);
const byBucket = tally(all, (r) => r.bucket);
const bySource = tally(all, (r) => r.src);
const byFamily = tally(all, (r) => r.fam);
// Cross-tab: source × bucket (India / Remote / International / Unknown).
const buckets = ["India", "Remote", "International", "Multiple", "Unknown"];
const sources = [...new Set(all.map((r) => r.src))].sort();
const cross = sources.map((s) => {
  const row = { source: s, total: 0 };
  for (const b of buckets) row[b] = 0;
  for (const r of all) if (r.src === s) { row[r.bucket]++; row.total++; }
  return row;
}).sort((a, b) => b.total - a.total);

const total = all.length;
const statsObj = {
  generated_at: new Date().toISOString(), total_jobs: total,
  sources_scanned: files.length, scan_times: perSourceScanTime,
  by_location: Object.fromEntries(byLocation), by_bucket: Object.fromEntries(byBucket),
  by_source: Object.fromEntries(bySource), by_family: Object.fromEntries(byFamily),
  source_x_bucket: cross,
};
writeFileSync("data/scan-stats.json", JSON.stringify(statsObj, null, 2));

// ── Markdown report ──────────────────────────────────────────────────
const pct = (n) => total ? `${Math.round((n / total) * 100)}%` : "0%";
const bar = (n, max) => "█".repeat(Math.max(0, Math.round((n / (max || 1)) * 20)));
const maxLoc = byLocation[0]?.[1] || 1;

let md = `# Scan Stats — ${new Date().toISOString().slice(0, 10)}\n\n`;
md += `**${total} jobs** across **${files.length} scanners** · filter: DevOps family, India-wide.\n\n`;

md += `## By location\n\n| Location | Jobs | Share | |\n|----------|-----:|------:|---|\n`;
for (const [loc, n] of byLocation) md += `| ${loc} | ${n} | ${pct(n)} | ${bar(n, maxLoc)} |\n`;

md += `\n## By region bucket\n\n| Bucket | Jobs | Share |\n|--------|-----:|------:|\n`;
for (const [b, n] of byBucket) md += `| ${b} | ${n} | ${pct(n)} |\n`;

md += `\n## By source\n\n| Source | Jobs | Share |\n|--------|-----:|------:|\n`;
for (const [s, n] of bySource) md += `| ${s} | ${n} | ${pct(n)} |\n`;

md += `\n## By role family\n\n| Family | Jobs | Share |\n|--------|-----:|------:|\n`;
for (const [fam, n] of byFamily) md += `| ${fam} | ${n} | ${pct(n)} |\n`;

md += `\n## Source × region\n\n| Source | India | Remote | Int'l | Unknown | Total |\n|--------|------:|------:|------:|------:|------:|\n`;
for (const r of cross) md += `| ${r.source} | ${r.India} | ${r.Remote} | ${r.International} | ${r.Unknown} | ${r.total} |\n`;
md += `\n_Source: data/*-scan.json (latest scan per platform). Regenerate: \`node scan-stats.mjs\`._\n`;
writeFileSync("data/scan-stats.md", md);

// ── Console ──────────────────────────────────────────────────────────
if (JSON_ONLY) { console.log(JSON.stringify(statsObj)); process.exit(0); }
console.log(`\n📊 Scan Stats — ${total} jobs across ${files.length} scanners\n`);
console.log("By location:");
for (const [loc, n] of byLocation) console.log(`  ${loc.padEnd(16)} ${String(n).padStart(3)}  ${bar(n, maxLoc)}`);
console.log("\nBy region:");
for (const [b, n] of byBucket) console.log(`  ${b.padEnd(16)} ${String(n).padStart(3)}  ${pct(n)}`);
console.log("\nBy source:");
for (const [s, n] of bySource) console.log(`  ${s.padEnd(16)} ${String(n).padStart(3)}`);
console.log("\nBy role family:");
for (const [fam, n] of byFamily) console.log(`  ${fam.padEnd(16)} ${String(n).padStart(3)}`);
console.log(`\n✅ Wrote data/scan-stats.md + data/scan-stats.json`);
process.exit(0);
