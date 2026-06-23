#!/usr/bin/env node
// build-workbook.mjs — ONE master Excel workbook with a sub-sheet (tab) per platform.
//
// Instead of scattered module folders, this rolls every scanner's latest results into a single
// workbook: reports_stats/<YYYY-MM-DD>/MASTER.xlsx, with one tab per platform (named after the
// platform) plus a "Summary" tab. Each tab is a funnel (Company–Role · Location · Exp · Link ·
// JD Fit · ATS · Pass · Status); the ⏳ columns fill when you say "process the scan".
//
//   node build-workbook.mjs          # rebuild the master workbook from all scan JSON
//
// Zero tokens — pure aggregation over data/*-scan.json.

import ExcelJS from "exceljs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { reportPaths } from "./reports-paths.mjs";

const RP = reportPaths();
const OUT = join(RP.dir, "MASTER.xlsx");

// Platform → which scan JSON feeds its tab (some files hold several sources → filter by source).
// tier: 1 = primary session scanners · 2 = secondary dedicated scanners · 3 = web-search ·
// 4 = remote/global boards (kept in the LAST section, per user).
const PLATFORMS = [
  // India-focused dedicated scanners first
  { tab: "LinkedIn", file: "devops-scan.json", tier: 1 },
  { tab: "Naukri", file: "naukri-scan.json", tier: 1 },
  { tab: "Instahyre", file: "instahyre-scan.json", tier: 2 },
  { tab: "Hirist", file: "hirist-scan.json", tier: 2 },
  { tab: "Glassdoor", file: "glassdoor-scan.json", tier: 2 },
  { tab: "Cutshort", file: "cutshort-scan.json", tier: 2 },
  { tab: "SimplyHired", file: "simplyhired-scan.json", tier: 2 },
  { tab: "Indeed", file: "indeed-scan.json", tier: 2 },
  { tab: "Foundit", file: "foundit-scan.json", tier: 2 },
  { tab: "NodeFlair", file: "nodeflair-scan.json", tier: 2 },
  { tab: "Wellfound", file: "wellfound-scan.json", tier: 2 },
  { tab: "WebSearch", file: "websearch-scan.json", tier: 3 }, // walled boards + Google/Dream
  // Remote / global boards — LAST section (per user)
  { tab: "RemoteOK", file: "remote-scan.json", source: "RemoteOK", tier: 4 },
  { tab: "Remotive", file: "remote-scan.json", source: "Remotive", tier: 4 },
  { tab: "Himalayas", file: "remote-scan.json", source: "Himalayas", tier: 4 },
  { tab: "WeWorkRemotely", file: "remote-scan.json", source: "WeWorkRemotely", tier: 4 },
];

function loadJobs(p) {
  const path = `data/${p.file}`;
  if (!existsSync(path)) return { jobs: [], scanned_at: "", missing: true };
  let data;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch { return { jobs: [], scanned_at: "", error: true }; }
  let jobs = data.jobs || [];
  if (p.source) jobs = jobs.filter((j) => (j.source || "") === p.source);
  return { jobs, scanned_at: data.scanned_at || "", walled: data.walled };
}

const HEADER_FILL = "FF2F5496";
const cellFill = (s) => {
  if (/🔵/.test(s)) return "FFCFE2F3"; // blue   (Applied)
  if (/🟠/.test(s)) return "FFFCE5CD"; // orange (held — questions pending)
  if (/🟢|✅/.test(s)) return "FFD7F5D7"; // green  (ready / pass)
  if (/🟡|⚠️/.test(s)) return "FFFDF2C7"; // yellow (borderline)
  if (/🔴|❌/.test(s)) return "FFF8D2D2"; // red    (skip / fail)
  if (/⚪|⏳/.test(s)) return "FFEDEDED"; // grey   (none / pending)
  return null;
};
function styleHeader(ws) {
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
}

const wb = new ExcelJS.Workbook();
const date = RP.date;
const summary = [];

// Summary tab FIRST so it's the landing tab.
const sum = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
sum.columns = [
  { header: "Tier", key: "Tier", width: 7 },
  { header: "Platform", key: "Platform", width: 18 },
  { header: "New jobs", key: "New jobs", width: 10 },
  { header: "Last scan", key: "Last scan", width: 20 },
  { header: "State", key: "State", width: 12 },
];
styleHeader(sum);

// One tab per platform.
for (const p of PLATFORMS) {
  const { jobs, scanned_at, walled } = loadJobs(p);
  summary.push({ tier: p.tier, platform: p.tab, jobs: jobs.length, walled: !!walled, scanned: scanned_at ? scanned_at.slice(0, 16).replace("T", " ") : "—" });

  const ws = wb.addWorksheet(p.tab.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
  const cols = ["#", "Company — Role", "Location", "Exp", "Link", "JD Fit", "ATS", "Pass", "Insight", "Résumé", "Status", "Applied"];
  ws.columns = cols.map((c) => ({
    header: c, key: c,
    width: c === "Company — Role" ? 40 : c === "Insight" ? 44 : c === "Location" ? 20 : c === "Link" ? 12 : c === "Exp" ? 14 : c === "Résumé" ? 12 : c === "Applied" ? 20 : Math.max(7, c.length + 3),
  }));
  styleHeader(ws);

  jobs.forEach((j, i) => {
    const company = j.company && j.company !== "—" ? j.company : "";
    const title = j.title || j.role || "—";
    const label = company ? `${company} — ${title}` : title;
    // Processed fields (filled by auto-process writing back to the scan JSON); ⏳ until then.
    const ats = j.ats != null ? (typeof j.ats === "number" ? `${j.ats}%` : String(j.ats)) : "⏳";
    const pass = j.pass === true ? "✅" : j.pass === false ? "❌" : "⏳";
    // Applied column: 🟠 applied by agent · 🟡 needs basic details (held on questions) · blank = not attempted.
    const appliedCell = j.applied === true ? "🟠 Applied (agent)"
      : j.applied === false ? "🟡 Basic details to fill" : "";
    const xr = ws.addRow({
      "#": i + 1, "Company — Role": label, Location: j.location || "India",
      Exp: j.exp || "", Link: "open",
      "JD Fit": j.jdFit || "⏳", ATS: ats, Pass: pass, Insight: j.insight || "⏳",
      "Résumé": j.resume ? "PDF" : "⏳", Status: j.status || "⏳ to process", Applied: appliedCell,
    });
    const link = j.url || j.apply_url;
    if (link) { const c = xr.getCell("Link"); c.value = { text: "open", hyperlink: link }; c.font = { color: { argb: "FF0563C1" }, underline: true }; }
    if (j.resume) { const c = xr.getCell("Résumé"); c.value = { text: "PDF", hyperlink: j.resume.startsWith("/") ? "file://" + j.resume : j.resume }; c.font = { color: { argb: "FF0563C1" }, underline: true }; }
    for (const col of ["JD Fit", "Pass", "Status", "Résumé", "Applied"]) {
      const f = cellFill(String(xr.getCell(col).value && xr.getCell(col).value.text ? xr.getCell(col).value.text : xr.getCell(col).value || ""));
      if (f) xr.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } };
    }
  });
  if (jobs.length === 0) {
    const xr = ws.addRow({ "#": "", "Company — Role": walled ? "(walled — see scanner)" : "(no new jobs this scan)", Status: walled ? "❌ wall" : "⚪ 0 new" });
    const f = cellFill(String(xr.getCell("Status").value || "")); if (f) xr.getCell("Status").fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } };
  }
  ws.autoFilter = { from: "A1", to: { row: 1, column: cols.length } };
}

// Fill the Summary tab (created first, above).
let total = 0;
for (const s of summary) {
  total += s.jobs;
  const xr = sum.addRow({ Tier: `T${s.tier}`, Platform: s.platform, "New jobs": s.jobs, "Last scan": s.scanned, State: s.walled ? "❌ wall" : s.jobs > 0 ? "✅ ok" : "⚪ 0" });
  const f = cellFill(String(xr.getCell("State").value || "")); if (f) xr.getCell("State").fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } };
}
const tr = sum.addRow({ Tier: "", Platform: "TOTAL", "New jobs": total, "Last scan": date, State: "" });
tr.font = { bold: true };

await wb.xlsx.writeFile(OUT);
console.error(`\n📒 MASTER workbook — ${PLATFORMS.length} platform tabs + Summary — ${total} jobs total`);
for (const s of summary) console.error(`   ${s.platform.padEnd(16)} ${String(s.jobs).padStart(3)}${s.walled ? "  (wall)" : ""}`);
console.error(`✅ ${OUT}`);
process.exit(0);
