#!/usr/bin/env node
// gen-pass-pdfs.mjs — generate a JD-tailored résumé PDF for every passing HYDERABAD job (pass===true
// and location Hyderabad/Secunderabad/Telangana)
// that doesn't have one yet, and record the path back into the scan JSON. Deduped by
// platform+company so we don't rebuild the same PDF for duplicate postings.
//
// Résumés are filed DATE-wise then COMPANY-wise (per user 2026-07-25):
//   ~/main/profile/<YYYY-MM-DD>/<Company>/Nikhil_DevOps_<Company>.pdf
// One folder per company per day, deduped across portals. Manual /jd applications
// live beside these in ~/main/profile/manual/<Company>/.
//
//   node gen-pass-pdfs.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve siblings by location, not by cwd — these moved into scripts/resume/ in the reorg
// and the bare-filename calls had been failing silently ever since.
const HERE = dirname(fileURLToPath(import.meta.url));
const TAILOR = join(HERE, "tailor-resume.mjs");
const BUILD = join(HERE, "build-resume.mjs");
const GENPDF = resolve(HERE, "..", "..", "generate-pdf.mjs");

const CV = "output/cv-content.json";
// Date-wise → company-wise under the user's profile folder (2026-07-25 structure).
const PROFILE_DIR = join(homedir(), "main", "profile");
// HYDERABAD ONLY (per Nikhil 2026-10-14): the dated profile folders must hold ONLY
// Hyderabad companies. Same location test the Hyderabad sheet uses so the folders and
// HYDERABAD.xlsx can never disagree. A pass=true job elsewhere gets no résumé.
const HYD = /hyderabad|secunderabad|telangana/i;
const inHyd = (j) => HYD.test(j.location || "");

const slug = (s) => (s || "Company").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "Company";

// Friendly platform label from the scan filename / per-job source (remote boards carry their own).
const SRC_LABEL = { devops: "LinkedIn", naukri: "Naukri", instahyre: "Instahyre", hirist: "Hirist",
  glassdoor: "Glassdoor", cutshort: "Cutshort", simplyhired: "SimplyHired", indeed: "Indeed",
  foundit: "Foundit", nodeflair: "NodeFlair", wellfound: "Wellfound", remote: "Remote", websearch: "WebSearch" };
const platformOf = (base, job) => slug(job.source || SRC_LABEL[base] || base);

const d = new Date();
const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Backfilling every missing résumé is a long run (one Playwright render each), so allow a
// bounded batch: --limit=N. Default unlimited.
const limitArg = process.argv.slice(2).find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

const doneByKey = new Map();
let made = 0, failed = 0, hitLimit = false;

for (const f of readdirSync("data").filter((x) => /-scan\.json$/.test(x))) {
  const path = `data/${f}`;
  const base = f.replace("-scan.json", "");
  let data; try { data = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
  let changed = false;
  for (const j of data.jobs || []) {
    if (j.pass !== true) continue;
    if (!inHyd(j)) continue; // non-Hyderabad posting — never gets a folder
    // A recorded path whose PDF no longer exists is NOT a résumé. Regenerate it — the old
    // `|| j.resume` check trusted the path alone and left 392 jobs pointing at nothing.
    if (j.resume && existsSync(j.resume.replace(/^~/, homedir()))) continue;
    if (made + failed >= LIMIT) { hitLimit = true; break; }
    const jd = (j.jd && j.jd.length > 80) ? j.jd : `${j.title || j.role}. ${Array.isArray(j.skills) ? "Skills: " + j.skills.join(", ") : ""}`;
    const key = slug(j.company);
    const platform = platformOf(base, j);
    // One résumé per company per DAY (deduped across portals): the same company found on
    // LinkedIn and Naukri the same day shares a PDF; a new day re-tailors fresh.
    const dedupKey = `${dateStr}/${key}`;
    let pdf = doneByKey.get(dedupKey);
    if (!pdf) {
      const tmp = join(tmpdir(), "gp-jd.txt");
      writeFileSync(tmp, jd);
      const dir = join(PROFILE_DIR, dateStr, key);
      mkdirSync(dir, { recursive: true });
      pdf = join(dir, `Nikhil_DevOps_${key}.pdf`);
      try {
        execFileSync(process.execPath, [TAILOR, tmp, CV, "output/tailored.json"], { stdio: "ignore" });
        execFileSync(process.execPath, [BUILD, "output/tailored.json", "output/tailored.html"], { stdio: "ignore" });
        execFileSync(process.execPath, [GENPDF, "output/tailored.html", pdf], { stdio: "ignore" });
        if (!existsSync(pdf)) throw new Error("no pdf");
        doneByKey.set(dedupKey, pdf); made++;
        process.stderr.write(`  ✅ ${dateStr}/${key} (${platform})\n`);
      } catch (e) { failed++; process.stderr.write(`  ✗ ${key}: ${e.message}\n`); continue; }
    }
    j.resume = pdf; changed = true;
  }
  if (changed) writeFileSync(path, JSON.stringify(data, null, 2));
  if (hitLimit) break;
}
console.error(`\n✅ generated ${made} unique résumé PDFs (${failed} failed). Rebuild: node scripts/sheets/build-hyderabad-sheet.mjs`);

// Coverage gate: every ATS-pass job must end this run holding a résumé that exists on disk.
// A missing one means a silent tailoring failure — surface it and exit non-zero.
const gaps = [];
for (const f of readdirSync("data").filter((x) => /-scan\.json$/.test(x))) {
  let data; try { data = JSON.parse(readFileSync(`data/${f}`, "utf8")); } catch { continue; }
  for (const j of data.jobs || []) {
    if (j.pass !== true) continue;
    if (!inHyd(j)) continue; // only Hyderabad jobs are required to hold a résumé
    const p = (j.resume || "").replace(/^~/, homedir());
    if (!j.resume) gaps.push(`${f}: ${j.company} — no résumé path`);
    else if (!existsSync(p)) gaps.push(`${f}: ${j.company} — résumé path missing on disk (${j.resume})`);
  }
}
if (gaps.length) {
  console.error(`\n${hitLimit ? "⏸" : "❌"} ${gaps.length} ATS-pass job(s) still WITHOUT a usable résumé:`);
  for (const g of gaps.slice(0, 10)) console.error(`   - ${g}`);
  if (gaps.length > 10) console.error(`   … and ${gaps.length - 10} more`);
  if (hitLimit) {
    console.error(`\n⏸  Stopped at --limit=${LIMIT}. Re-run to continue the backfill.`);
    process.exit(0);
  }
  process.exit(1); // unbounded run that still leaves gaps = real failure
}
console.error("🟢 every ATS-pass job has a résumé on disk.");
process.exit(0);
