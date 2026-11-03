#!/usr/bin/env node
// build-tracker.mjs — a date-wise APPLICATION TRACKER sheet.
//
// Reads every portal's accumulated jobs and rolls the actionable ones (Ready to apply +
// Applied + held-for-questions) into one downloadable, DATE-WISE sheet:
//   reports_stats/<date>/TRACKER.xlsx   — Date | Portal | Company | Role | ATS | Status | Applied On
//
// It answers "what did we apply to, and when" and "what is ready to apply, by date" at a glance.
// Rows are grouped newest-date first. Also writes data/tracker.tsv (plain log).
//
//   node build-tracker.mjs

import ExcelJS from "exceljs";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { reportPaths } from "../lib/reports-paths.mjs";

const RP = reportPaths();
// Hidden scratch, NOT the date folder — the date folder holds ONLY the 3 sheets the
// user reviews (HYDERABAD / MASTER / NAUKRI, per user 2026-07-18). tracker.tsv is
// unchanged; ask for "the tracker" to get this xlsx.
const OUT = RP.md("TRACKER.xlsx");
const TSV = "data/tracker.tsv";

const SRC = { devops: "LinkedIn", naukri: "Naukri", instahyre: "Instahyre", hirist: "Hirist",
  glassdoor: "Glassdoor", cutshort: "Cutshort", simplyhired: "SimplyHired", indeed: "Indeed",
  foundit: "Foundit", nodeflair: "NodeFlair", wellfound: "Wellfound", remote: "Remote" };

const today = RP.date;
const rows = [];
for (const f of (existsSync("data") ? readdirSync("data").filter((x) => /-scan\.json$/.test(x)) : [])) {
  let d; try { d = JSON.parse(readFileSync(`data/${f}`, "utf8")); } catch { continue; }
  const base = f.replace("-scan.json", "");
  for (const j of d.jobs || []) {
    const isApplied = j.applied === true;
    const isHeld = j.applied === false;
    const isReady = j.pass === true || /🟢/.test(j.status || "");
    if (!isApplied && !isHeld && !isReady) continue; // only actionable rows
    const status = isApplied ? "🟠 Applied by agent" : isHeld ? "🟡 Fill details manually" : "🟢 Ready to apply";
    const date = isApplied ? (j.applied_at || today) : (j.processed_at ? j.processed_at.slice(0, 10) : today);
    rows.push({
      date,
      portal: j.source || SRC[base] || base,
      company: j.company && j.company !== "—" ? j.company : (j.title || j.role || "—"),
      role: j.title || j.role || "",
      ats: j.ats != null ? `${j.ats}%` : "",
      status,
      appliedOn: isApplied ? (j.applied_at || today) : "",
    });
  }
}
// newest date first, then Applied before Ready within a date
rows.sort((a, b) => (b.date.localeCompare(a.date)) || a.status.localeCompare(b.status) || a.portal.localeCompare(b.portal));

// ── TSV log ──
let tsv = "date\tportal\tcompany\trole\tats\tstatus\tapplied_on\n";
for (const r of rows) tsv += `${r.date}\t${r.portal}\t${r.company}\t${r.role}\t${r.ats}\t${r.status.replace(/[🟠🟡🟢]\s*/g, "")}\t${r.appliedOn}\n`;
writeFileSync(TSV, tsv);

// ── XLSX ──
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Tracker", { views: [{ state: "frozen", ySplit: 1 }] });
ws.columns = [
  { header: "Date", key: "Date", width: 12 },
  { header: "Portal", key: "Portal", width: 14 },
  { header: "Company", key: "Company", width: 28 },
  { header: "Role", key: "Role", width: 40 },
  { header: "ATS", key: "ATS", width: 8 },
  { header: "Status", key: "Status", width: 24 },
  { header: "Applied On", key: "Applied On", width: 14 },
];
ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } }; c.alignment = { horizontal: "center" }; });
// Row colors (whole row, so each state reads at a glance):
//   🟠 Applied by agent → DARK GREEN (white bold) — already done
//   🟡 Fill details manually → YELLOW — needs your attention
//   🟢 Ready to apply → light green
const rowFill = (s) => /🟠/.test(s) ? "FF1E7D32" : /🟡/.test(s) ? "FFFFE600" : /🟢/.test(s) ? "FFD7F5D7" : null;
let lastDate = "";
for (const r of rows) {
  const xr = ws.addRow(r);
  if (r.date !== lastDate) { xr.getCell("Date").font = { bold: true }; lastDate = r.date; }
  const f = rowFill(r.status);
  if (f) {
    const dark = /🟠/.test(r.status); // applied-by-agent = dark green, needs white text
    xr.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } };
      if (dark) c.font = { ...(c.font || {}), color: { argb: "FFFFFFFF" }, bold: true };
    });
  }
}
ws.autoFilter = { from: "A1", to: { row: 1, column: 7 } };

// Legend row at the bottom so the color meaning is self-explanatory.
ws.addRow([]);
const legend = [
  { txt: "🟠 Applied by agent (done)", argb: "FF1E7D32", white: true },
  { txt: "🟡 Fill details manually", argb: "FFFFE600", white: false },
  { txt: "🟢 Ready to apply", argb: "FFD7F5D7", white: false },
];
for (const l of legend) {
  const lr = ws.addRow(["", l.txt]);
  const cell = lr.getCell(2);
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: l.argb } };
  cell.font = { bold: true, color: { argb: l.white ? "FFFFFFFF" : "FF000000" } };
}

// Summary tab — counts per date.
const sum = wb.addWorksheet("By Date", { views: [{ state: "frozen", ySplit: 1 }] });
sum.columns = [{ header: "Date", key: "Date", width: 12 }, { header: "Applied", key: "Applied", width: 10 }, { header: "Ready", key: "Ready", width: 10 }, { header: "Needs details", key: "Needs details", width: 14 }];
sum.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } }; });
const byDate = {};
for (const r of rows) { const b = (byDate[r.date] = byDate[r.date] || { Applied: 0, Ready: 0, "Needs details": 0 }); if (/🟠/.test(r.status)) b.Applied++; else if (/🟡/.test(r.status)) b["Needs details"]++; else b.Ready++; }
for (const date of Object.keys(byDate).sort().reverse()) sum.addRow({ Date: date, ...byDate[date] });

await wb.xlsx.writeFile(OUT);
const applied = rows.filter((r) => /🟠/.test(r.status)).length;
const ready = rows.filter((r) => /🟢/.test(r.status)).length;
const held = rows.filter((r) => /🟡/.test(r.status)).length;
console.error(`\n📋 TRACKER — ${rows.length} actionable jobs · ${applied} applied · ${ready} ready · ${held} need details`);
console.error(`✅ ${OUT}\n✅ ${TSV}`);
process.exit(0);
