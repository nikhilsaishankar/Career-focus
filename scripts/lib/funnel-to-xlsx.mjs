#!/usr/bin/env node
// funnel-to-xlsx.mjs — convert a funnel markdown table into a clean, colored Excel sheet.
//
// The scans append to the .md (easy to grow); this renders the latest .md as .xlsx with a
// Date column, clickable links, and green/yellow/red Status cells — easier to scan visually.
//
// Usage: node funnel-to-xlsx.mjs [input.md] [output.xlsx]
//        defaults: MODULE-01.md → MODULE-01.xlsx

import ExcelJS from "exceljs";
import { readFileSync, existsSync } from "node:fs";

const IN = process.argv[2] || "MODULE-01.md";
const OUT = process.argv[3] || IN.replace(/\.md$/, "") + ".xlsx";
if (!existsSync(IN)) { console.error(`✗ ${IN} not found`); process.exit(1); }

// --- parse the markdown: track `## date` headings + pipe-table rows ---
const lines = readFileSync(IN, "utf8").split("\n");
let header = null;
let curDate = "";
const rows = []; // { date, cells: [...] }
const splitRow = (l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
for (const l of lines) {
  const m = l.match(/^##\s+(.+)$/);
  if (m) { curDate = m[1].trim(); continue; }
  if (!/^\s*\|/.test(l)) continue;
  if (/^\s*\|[\s:|-]+\|?\s*$/.test(l)) continue; // separator row
  const cells = splitRow(l);
  if (!header) { header = cells; continue; }
  rows.push({ date: curDate, cells });
}
if (!header) { console.error("✗ no table found in " + IN); process.exit(1); }

// markdown [text](url) → { text, url }
const linkOf = (s) => {
  const m = s && s.match(/\[([^\]]*)\]\(([^)]+)\)/);
  return m ? { text: m[1], url: m[2] } : null;
};
// color any "status-like" cell by its marker (works for Status AND the OK ✅/❌ column)
const cellFill = (s) => {
  if (/🟢|✅/.test(s)) return "FFD7F5D7"; // green  (done / ready)
  if (/🟡|⚠️/.test(s)) return "FFFDF2C7"; // yellow (borderline / partial-fail)
  if (/🔴|❌/.test(s)) return "FFF8D2D2"; // red    (skip / fail)
  if (/⚪|⏳/.test(s)) return "FFEDEDED"; // grey   (none / pending)
  return null;
};

// --- build the workbook ---
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Funnel", { views: [{ state: "frozen", ySplit: 1 }] });
const cols = ["Date", ...header];
ws.columns = cols.map((c) => ({ header: c, key: c, width: c === "Company — Role" ? 42 : c === "Link" ? 16 : Math.max(8, c.length + 3) }));

// header style
ws.getRow(1).eachCell((cell) => {
  cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
  cell.alignment = { vertical: "middle", horizontal: "center" };
});

const linkCols = new Set(["Link", "Résumé"]);
for (const r of rows) {
  const rowObj = { Date: r.date };
  header.forEach((h, i) => { rowObj[h] = r.cells[i] ?? ""; });
  const xr = ws.addRow(rowObj);
  // hyperlinks for Link / Résumé columns
  for (const h of header) {
    if (!linkCols.has(h)) continue;
    const lk = linkOf(rowObj[h]);
    const cell = xr.getCell(h);
    if (lk) { cell.value = { text: lk.text || "open", hyperlink: lk.url }; cell.font = { color: { argb: "FF0563C1" }, underline: true }; }
  }
  // color the status-like cells (Status and/or OK), only those that exist
  for (const c of ["Status", "OK"]) {
    if (!cols.includes(c)) continue;
    const fill = cellFill(String(rowObj[c] || ""));
    if (fill) xr.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  }
  xr.alignment = { vertical: "middle", wrapText: false };
}
ws.autoFilter = { from: "A1", to: { row: 1, column: cols.length } };

await wb.xlsx.writeFile(OUT);
console.error(`✅ ${rows.length} rows → ${OUT}`);
