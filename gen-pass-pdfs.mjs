#!/usr/bin/env node
// gen-pass-pdfs.mjs — generate a JD-tailored résumé PDF for every passing job (pass===true)
// that doesn't have one yet, and record the path back into the scan JSON. Deduped by company
// so we don't rebuild the same PDF for duplicate postings.
//
//   node gen-pass-pdfs.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const CV = "output/cv-content.json";
const PROFILE_DIR = join(homedir(), "Documents", "profile");
const slug = (s) => (s || "Company").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "Company";

const doneByCompany = new Map();
let made = 0, failed = 0;

for (const f of readdirSync("data").filter((x) => /-scan\.json$/.test(x))) {
  const path = `data/${f}`;
  let data; try { data = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
  let changed = false;
  for (const j of data.jobs || []) {
    if (j.pass !== true || j.resume) continue;
    const jd = (j.jd && j.jd.length > 80) ? j.jd : `${j.title || j.role}. ${Array.isArray(j.skills) ? "Skills: " + j.skills.join(", ") : ""}`;
    const key = slug(j.company);
    let pdf = doneByCompany.get(key);
    if (!pdf) {
      const tmp = join(tmpdir(), "gp-jd.txt");
      writeFileSync(tmp, jd);
      pdf = join(PROFILE_DIR, `Nikhil_DevOps_${key}.pdf`);
      try {
        execFileSync(process.execPath, ["tailor-resume.mjs", tmp, CV, "output/tailored.json"], { stdio: "ignore" });
        execFileSync(process.execPath, ["build-resume.mjs", "output/tailored.json", "output/tailored.html"], { stdio: "ignore" });
        execFileSync(process.execPath, ["generate-pdf.mjs", "output/tailored.html", pdf], { stdio: "ignore" });
        if (!existsSync(pdf)) throw new Error("no pdf");
        doneByCompany.set(key, pdf); made++;
        process.stderr.write(`  ✅ ${key}\n`);
      } catch (e) { failed++; process.stderr.write(`  ✗ ${key}: ${e.message}\n`); continue; }
    }
    j.resume = pdf; changed = true;
  }
  if (changed) writeFileSync(path, JSON.stringify(data, null, 2));
}
console.error(`\n✅ generated ${made} unique résumé PDFs (${failed} failed). Rebuild: node build-workbook.mjs`);
process.exit(0);
