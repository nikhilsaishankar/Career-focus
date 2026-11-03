#!/usr/bin/env node
// process-scans.mjs — fill the funnel for every scanned job that has a JD (or skills): run the
// ATS check vs the CV, derive JD-Fit + go/skip insight + status, tailor a résumé PDF for the
// passes, and write it all back into the data/*-scan.json so build-workbook.mjs renders it.
//
// Deterministic + zero-token for the scoring (uses ats-check.mjs). Jobs with no JD text and no
// skills are left ⏳ for the agent pass (auto-process.sh) to WebFetch + score.
//
//   node process-scans.mjs            # score+fill all jobs that have JD/skills, PDF for passes
//   node process-scans.mjs --no-pdf   # skip résumé PDF generation (faster)
//
// After it runs, rebuild the workbook: node build-workbook.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { sheetAdmits } from "../lib/job-filters.mjs";

const NO_PDF = process.argv.includes("--no-pdf");
const CV = "output/cv-content.json";
const PROFILE_DIR = join(homedir(), "main", "profile");
const PASS = 75;

function jdTextOf(j) {
  if (j.jd && j.jd.length > 80) return j.jd;
  // No JD body — synthesize from title + skills (e.g. Foundit) so ATS has keywords to match.
  if (Array.isArray(j.skills) && j.skills.length) return `${j.title || j.role}. Required skills: ${j.skills.join(", ")}.`;
  if (typeof j.skills === "string" && j.skills.length > 10) return `${j.title || j.role}. Required skills: ${j.skills}.`;
  return null;
}

function ats(jdText) {
  const tmp = join(tmpdir(), `jd-${Math.abs(hash(jdText))}.txt`);
  writeFileSync(tmp, jdText);
  let out = "";
  try { out = execFileSync(process.execPath, ["scripts/resume/ats-check.mjs", CV, tmp], { encoding: "utf8" }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  const cov = (out.match(/Coverage\s*:\s*(\d+)%/) || [])[1];
  const miss = (out.match(/Missing \(in JD, not r[ée]sum[ée]\):\s*(.+)/) || [])[1] || "";
  return { pct: cov != null ? parseInt(cov, 10) : null, missing: miss.trim() };
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

const slug = (s) => (s || "Company").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "Company";

function tailorPdf(jdText, company) {
  if (NO_PDF) return null;
  const tmp = join(tmpdir(), "ps-jd.txt");
  writeFileSync(tmp, jdText);
  const pdf = join(PROFILE_DIR, `Nikhil_DevOps_${slug(company)}.pdf`);
  try {
    execFileSync(process.execPath, ["tailor-resume.mjs", tmp, CV, "output/tailored.json"], { stdio: "ignore" });
    execFileSync(process.execPath, ["build-resume.mjs", "output/tailored.json", "output/tailored.html"], { stdio: "ignore" });
    execFileSync(process.execPath, ["generate-pdf.mjs", "output/tailored.html", pdf], { stdio: "ignore" });
    return existsSync(pdf) ? pdf : null;
  } catch { return null; }
}

const files = readdirSync("data").filter((f) => /-scan\.json$/.test(f));
let scored = 0, passes = 0, skippedNoJd = 0;

for (const f of files) {
  const path = `data/${f}`;
  let data;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
  let changed = false;
  for (const j of data.jobs || []) {
    if (j.ats != null) continue; // already processed
    const jd = jdTextOf(j);
    if (!jd) { skippedNoJd++; continue; }
    const { pct, missing } = ats(jd);
    if (pct == null) { skippedNoJd++; continue; }
    // ATS score alone is not the shortlist gate — it just measures keyword overlap and
    // can't tell "AWS/EKS mentioned in a Go Lang JD" from a real DevOps role. Every pass
    // must ALSO clear sheetAdmits() (job-filters.mjs), the same gate the HYDERABAD sheet
    // and /jd use — otherwise wrong-core/over-experience jobs still get a résumé PDF.
    const atsOk = pct >= PASS;
    const gateOk = sheetAdmits(j);
    const pass = atsOk && gateOk;
    const jdFit = pass ? "✅" : pct >= 60 ? "⚠️" : "❌";
    const status = pass ? "🟢 Ready to apply" : pct >= 60 ? "🟡 Borderline" : "🔴 Skip";
    const missTop = missing ? missing.split(/,\s*/).slice(0, 3).join(", ") : "";
    const insight = pass
      ? `Strong match (${pct}%) — apply${missTop ? `; minor gaps: ${missTop}` : ""}`
      : atsOk && !gateOk
        ? `${pct}% ATS match but fails fit gate (wrong core stack / experience floor / employer) — skip`
        : `${pct}% match${missTop ? ` — missing ${missTop}` : ""} — ${pct >= 60 ? "borderline, review" : "skip"}`;
    j.jdFit = jdFit; j.ats = pct; j.pass = pass; j.status = status; j.insight = insight;
    if (pass) { const pdf = tailorPdf(jd, j.company); if (pdf) j.resume = pdf; passes++; }
    j.processed_at = new Date().toISOString();
    scored++; changed = true;
    process.stderr.write(`  ${f.replace("-scan.json", "").padEnd(12)} ${jdFit} ${String(pct).padStart(3)}%  ${(j.company || "—").slice(0, 22).padEnd(22)} ${(j.title || j.role || "").slice(0, 40)}\n`);
  }
  if (changed) writeFileSync(path, JSON.stringify(data, null, 2));
}

console.error(`\n✅ scored ${scored} jobs · ${passes} passes (≥${PASS}%, PDF tailored) · ${skippedNoJd} left ⏳ (no JD — need fetch)`);
console.error(`   now run: node build-workbook.mjs`);
process.exit(0);
