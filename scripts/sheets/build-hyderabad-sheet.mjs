#!/usr/bin/env node
// build-hyderabad-sheet.mjs — the HYDERABAD OPENINGS sheet (per user 2026-07-17).
//
// Rolls Naukri + LinkedIn + Google (jobs tab) into ONE Hyderabad-only view:
//   reports_stats/<date>/HYDERABAD.xlsx   — "New Today" tab + "Audit" tab
//   data/.module-scratch/<date>/module16-Hyderabad.md (+ .xlsx render)
//
// Rules:
//   • DevOps family · location Hyderabad/Secunderabad/Telangana · required exp ≤ 4 yrs
//   • NEW-TODAY ONLY: a job first seen on an earlier day never reappears (seen-ledger),
//     i.e. "today we added X company, tomorrow X still present → ignore".
//   • STRICT AUDIT: every source must have scanned TODAY — a stale source fails the run,
//     and each run is appended to data/hyderabad-audit.log + the slot table in the md.
//
//   node build-hyderabad-sheet.mjs        # build sheet + audit (called by the pipeline)
//
// Zero tokens — pure aggregation over data/*-scan.json + data/.pool/.

import ExcelJS from "exceljs";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { reportPaths } from "../lib/reports-paths.mjs";
import { makeFreshFilter, todayStr } from "../lib/seen-ledger.mjs";
import { sheetAdmits, hasCoreStack, dupKey } from "../lib/job-filters.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RP = reportPaths();
const OUT = join(RP.dir, "HYDERABAD.xlsx");
const STATUS = RP.md("module16-Hyderabad.md");
const XLSX_MD = RP.md("module16-Hyderabad.xlsx"); // hidden scratch — audit already lives in HYDERABAD.xlsx's Audit tab
const RUNS = RP.md(".module16-runs.tsv");
const AUDIT_LOG = "data/hyderabad-audit.log";

// ONLY the portals we can genuinely scan (per user 2026-07-23): LinkedIn, Naukri,
// Google jobs tab, Indeed, Hirist, Instahyre — nothing else contributes rows.
// PRIMARY sources are STRICT: stale/walled ⇒ run fails. Indeed/Hirist/Instahyre
// scan on the dispatcher's own cadence, so their freshness is informational.
const PRIMARY = [
  { name: "Naukri", file: "naukri-scan.json" },
  { name: "LinkedIn", file: "devops-scan.json" },
  { name: "Google", file: "google-scan.json" },
];
const SECONDARY = [
  { name: "Indeed", file: "indeed-scan.json" },
  { name: "Hirist", file: "hirist-scan.json" },
  { name: "Instahyre", file: "instahyre-scan.json" },
  // Added 2026-10-14 per Nikhil ("all Hyderabad location DevOps related must never be
  // skipped"): the WebSearch sweep was scanning Hyderabad DevOps roles but its rows never
  // reached the sheet, so admissible jobs were being dropped. Secondary, like the others —
  // its freshness is informational and never fails a run. This widens the 2026-07-23
  // six-portal rule by one genuinely-scannable source.
  { name: "WebSearch", file: "websearch-scan.json" },
];
const SOURCES = [
  ...PRIMARY.map((s) => ({ ...s, strict: true })),
  ...SECONDARY.map((s) => ({ ...s, strict: false })),
];

const HYD = /hyderabad|secunderabad|telangana/i;
const DEVOPS_TITLE =
  /dev[\s-]?(sec[\s-]?)?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release|kubernetes|\bk8s\b/i;
// Required-experience ceiling. Default 4 keeps the daily pipeline's long-standing band;
// --expmax=5 widens it for the all-platform deep dive (Nikhil 2026-10-26: "below 5 yrs").
const expMaxArg = process.argv.slice(2).find((a) => a.startsWith("--expmax="));
const EXP_MAX = expMaxArg ? parseFloat(expMaxArg.slice(9)) : 4;

// pool + latest scan merge — same recipe as build-workbook.mjs.
const PROC = ["ats", "jdFit", "pass", "insight", "resume", "status", "applied", "applied_at", "questions", "processed_at"];
const jobKey = (j) => String(j.id ?? j.jobId ?? `${j.company}|${j.title || j.role}`);
function loadJobs(file) {
  const readJobs = (p) => { try { return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).jobs || []) : []; } catch { return []; } };
  let meta = {};
  try { if (existsSync(`data/${file}`)) meta = JSON.parse(readFileSync(`data/${file}`, "utf8")); } catch {}
  const byId = new Map();
  for (const j of readJobs(`data/.pool/${file}`)) byId.set(jobKey(j), { ...j });
  for (const j of readJobs(`data/${file}`)) {
    const k = jobKey(j), prev = byId.get(k);
    if (!prev) { byId.set(k, { ...j }); continue; }
    const merged = { ...prev, ...j };
    for (const f of PROC) if (j[f] === undefined && prev[f] !== undefined) merged[f] = prev[f];
    byId.set(k, merged);
  }
  return { jobs: [...byId.values()], scanned_at: meta.scanned_at || "", walled: !!meta.walled };
}

// ---------- COLLECT ----------
const today = todayStr();
const fresh = makeFreshFilter(today);
const rows = [];
const audit = [];
for (const s of SOURCES) {
  const { jobs, scanned_at, walled } = loadJobs(s.file);
  const scannedToday = scanned_at.slice(0, 10) === today;
  let inHyd = 0, newToday = 0;
  for (const j of jobs) {
    const title = j.title || j.role || "";
    const loc = j.location || "";
    if (!HYD.test(loc)) continue;
    // Title can be ANYTHING (per Nikhil 2026-07-27): a job enters on a DevOps-family
    // title OR on its text showing his core stack — the stack is the real judge.
    if (!DEVOPS_TITLE.test(title) && !hasCoreStack(j)) continue;
    // Strict admission — IDENTICAL to the /jd gate: exp floor ≤4, no Azure/GCP-centric,
    // no VMware/sysadmin cores under DevOps titles, no training-academy employers.
    if (!sheetAdmits(j, EXP_MAX)) continue;
    inHyd++;
    if (!fresh.isFreshToday(j)) continue; // seen on an earlier day → ignore (dedup rule)
    newToday++;
    rows.push({ ...j, _source: s.name, _title: title });
  }
  audit.push({ source: s.name, strict: !!s.strict, scanned_at, scannedToday, walled, inHyd, newToday });
}
fresh.commit();

// De-dup across sources (same company+role found via Google AND Naukri → keep first, note both).
const byName = new Map();
for (const r of rows) {
  const k = dupKey({ company: r.company, title: r._title }); // normalized: company-name variants collapse
  const prev = byName.get(k);
  if (!prev) byName.set(k, r);
  else prev._also = (prev._also ? prev._also + ", " : "") + r._source;
}
const finalRows = [...byName.values()];

// ---------- STRICT AUDIT VERDICT ----------
// Fails when: a PRIMARY source (Naukri/LinkedIn/Google) is stale or walled, OR any row
// on today's sheet is still unprocessed (no ATS score) — "nothing supposed to be loading".
// NOTE (2026-08-14): résumé PDFs are no longer auto-generated in the background pipeline
// (per user — scan/score/notify only, résumé built only on explicit request), so a missing
// .resume on a pass row is expected now, not a failure. Do not add that check back here
// without the auto-PDF step also coming back.
const staleSources = audit.filter((a) => a.strict && !a.scannedToday);
const walledSources = audit.filter((a) => a.strict && a.walled);
const pendingRows = finalRows.filter((j) => j.ats == null);
const runOk = staleSources.length === 0 && walledSources.length === 0 && pendingRows.length === 0;
const verdict = runOk
  ? `✅ Passed — 3 primary sources fresh · ${finalRows.length} new Hyderabad job(s) · all rows processed`
  : `❌ Failed — ${[
      ...staleSources.map((a) => `${a.source} STALE (last scan ${a.scanned_at.slice(0, 16) || "never"})`),
      ...walledSources.map((a) => `${a.source} WALLED`),
      ...(pendingRows.length ? [`${pendingRows.length} row(s) unprocessed (no JD/ATS yet)`] : []),
    ].join(" · ")}`;

// ---------- EXCEL ----------
const HEADER_FILL = "FF2F5496";
const cellFill = (s) => {
  if (/🔵/.test(s)) return "FFCFE2F3";
  if (/🟠/.test(s)) return "FFFCE5CD";
  if (/🟢|✅/.test(s)) return "FFD7F5D7";
  if (/🟡|⚠️/.test(s)) return "FFFDF2C7";
  if (/🔴|❌/.test(s)) return "FFF8D2D2";
  if (/⚪|⏳/.test(s)) return "FFEDEDED";
  return null;
};
const styleHeader = (ws) => ws.getRow(1).eachCell((cell) => {
  cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  cell.alignment = { vertical: "middle", horizontal: "center" };
});

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("New Today", { views: [{ state: "frozen", ySplit: 1 }] });
const cols = ["#", "Source", "Company — Role", "Location", "Exp", "Posted", "Link", "JD Fit", "ATS", "Pass", "Résumé", "Status", "Applied"];
ws.columns = cols.map((c) => ({
  header: c, key: c,
  width: c === "Company — Role" ? 42 : c === "Location" ? 22 : c === "Applied" ? 46 : c === "Source" ? 11 : c === "Posted" ? 12 : c === "Exp" ? 14 : Math.max(7, c.length + 3),
}));
styleHeader(ws);
finalRows.forEach((j, i) => {
  const label = j.company ? `${j.company} — ${j._title}` : j._title;
  const ats = j.ats != null ? (typeof j.ats === "number" ? `${j.ats}%` : String(j.ats)) : "⏳";
  const pass = j.pass === true ? "✅" : j.pass === false ? "❌" : "⏳";
  const qs = Array.isArray(j.questions) ? j.questions.filter(Boolean) : [];
  const appliedCell = j.applied === true ? "🟠 Applied (agent)" : j.applied === false ? (qs.length ? `🟡 Fill: ${qs.slice(0, 4).join(" · ")}` : "🟡 Basic details to fill") : "";
  // Résumé: PDF for passes · "—" for scored skips (nothing is pending there) · ⏳ ONLY
  // while a row is genuinely unprocessed (which also fails the strict audit).
  const resumeCell = j.resume ? "PDF" : j.ats != null ? "—" : "⏳";
  const xr = ws.addRow({
    "#": i + 1, Source: j._source + (j._also ? ` +${j._also}` : ""), "Company — Role": label,
    Location: j.location || "Hyderabad", Exp: j.exp || "", Posted: j.posted || "",
    Link: "open", "JD Fit": j.jdFit || "⏳", ATS: ats, Pass: pass,
    "Résumé": resumeCell, Status: j.status || "⏳ to process", Applied: appliedCell,
  });
  const link = j.url || j.apply_url;
  if (link) { const c = xr.getCell("Link"); c.value = { text: "open", hyperlink: link }; c.font = { color: { argb: "FF0563C1" }, underline: true }; }
  if (j.resume) { const c = xr.getCell("Résumé"); c.value = { text: "PDF", hyperlink: j.resume.startsWith("/") ? "file://" + j.resume : j.resume }; c.font = { color: { argb: "FF0563C1" }, underline: true }; }
  for (const col of ["JD Fit", "Pass", "Status", "Résumé", "Applied"]) {
    const v = xr.getCell(col).value;
    const f = cellFill(String(v && v.text ? v.text : v || ""));
    if (f) xr.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } };
  }
});
if (finalRows.length === 0) ws.addRow({ "#": "", "Company — Role": "(no NEW Hyderabad jobs this run — earlier finds live in MASTER.xlsx / tracker)", Status: "⚪ 0 new" });
ws.autoFilter = { from: "A1", to: { row: 1, column: cols.length } };

const aud = wb.addWorksheet("Audit", { views: [{ state: "frozen", ySplit: 1 }] });
aud.columns = [
  { header: "Source", key: "Source", width: 12 },
  { header: "Last scan", key: "Last scan", width: 20 },
  { header: "Fresh today", key: "Fresh today", width: 12 },
  { header: "Hyd jobs (all-time)", key: "Hyd jobs (all-time)", width: 18 },
  { header: "New today", key: "New today", width: 11 },
  { header: "State", key: "State", width: 30 },
];
styleHeader(aud);
for (const a of audit) {
  const state = a.walled
    ? (a.strict ? "❌ walled" : "⚠️ walled (info)")
    : a.scannedToday ? "✅ ok"
    : a.strict ? "❌ stale — scan did not run today" : "⚪ info — scans on dispatcher cadence";
  const xr = aud.addRow({
    Source: a.source + (a.strict ? " *" : ""), "Last scan": a.scanned_at ? a.scanned_at.slice(0, 16).replace("T", " ") : "never",
    "Fresh today": a.scannedToday ? "✅" : "—", "Hyd jobs (all-time)": a.inHyd, "New today": a.newToday,
    State: state,
  });
  const f = cellFill(String(xr.getCell("State").value || "")); if (f) xr.getCell("State").fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } };
}
aud.addRow({ Source: "* strict", State: "starred sources must be fresh every run; others contribute rows on their own cadence" });
aud.addRow({});
aud.addRow({ Source: "VERDICT", State: verdict });
await wb.xlsx.writeFile(OUT);

// ---------- MODULE MD (slot table, module05-style) + AUDIT LOG ----------
const now = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const time = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
// Scheduled slots (per user 2026-07-25): 03:00 late-night · 08:00 morning · 18:00 evening · 20:00 night.
const SLOTS = [["🌃 Late Night", "03:00"], ["🌅 Morning", "08:00"], ["🌆 Evening", "18:00"], ["🌙 Night", "20:00"]];
const slotOf = (hhmm) => { const h = +hhmm.slice(0, 2); return h < 6 ? "03:00" : h < 14 ? "08:00" : h < 19 ? "18:00" : "20:00"; };
const sched = process.env.HYD_SLOT || slotOf(time);
appendFileSync(RUNS, `${today}\t${time}\t${sched}\t${runOk ? "OK" : "FAIL"}\t${finalRows.length} new\t${verdict.replace(/[\t\n]/g, " ")}\n`);

const runRows = readFileSync(RUNS, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const byDate = {};
for (const [d, t, sc, st, cnt, why] of runRows) {
  (byDate[d] ||= {});
  const cur = byDate[d][sc];
  const cand = { t, ok: st === "OK", cnt, why };
  if (!cur || (cand.ok && !cur.ok) || (cand.ok === cur.ok && t < cur.t)) byDate[d][sc] = cand;
}
byDate[today] ||= {};
const nowMin = now.getHours() * 60 + now.getMinutes();
let md =
  "# Module 16 — Hyderabad Openings (Naukri + LinkedIn + Google)\n\n" +
  "STRICT daily schedule — 03:00 · 08:00 · 18:00 · 20:00 (headless, background). Each run sweeps the DevOps family across all sources, keeps roles in Hyderabad requiring ≤4 yrs, and shows ONLY jobs first seen today (yesterday's finds never repeat). A run passes only when every source scanned fresh today.\n" +
  "**Day verdict: ✅ Passed only when all 4 slots ran and every source was fresh in each.**\n";
for (const d of Object.keys(byDate).sort()) {
  md += `\n## ${d}\n\n| Slot | Scheduled | Ran at | New jobs | Status | Remarks |\n|------|-----------|--------|----------|--------|---------|\n`;
  let done = 0, failed = 0, missed = 0;
  for (const [phase, sc] of SLOTS) {
    const r = byDate[d][sc];
    let status, remark = "—", cnt = "—", ranAt = "—";
    if (r) {
      ranAt = r.t; cnt = r.cnt;
      if (r.ok) { status = "✅ done"; done++; }
      else { status = "⚠️ fail"; failed++; remark = r.why; }
    } else {
      const passed = d < today || (d === today && (+sc.slice(0, 2) * 60 + +sc.slice(3)) < nowMin);
      if (passed) { status = "❌ not done"; missed++; remark = "no run — Mac off/asleep at slot time"; }
      else status = "⏳ pending";
    }
    md += `| ${phase} | ${sc} | ${ranAt} | ${cnt} | ${status} | ${remark} |\n`;
  }
  const detail = [failed && `${failed} fail`, missed && `${missed} missed`].filter(Boolean).join(" · ");
  const overall = done >= SLOTS.length ? "✅ Passed — all slots done" : failed || missed ? `❌ Failed — ${done}/${SLOTS.length} done${detail ? " · " + detail : ""}` : `⏳ In progress — ${done}/${SLOTS.length} done`;
  md += `| 📋 Overall | — | — | — | ${overall} | ${detail || "—"} |\n`;
}
md += `\n## Latest run — source audit (${today} ${time})\n\n| Source | Last scan | Fresh today | Hyd jobs (all-time) | New today | State |\n|--------|-----------|-------------|--------------------|-----------|-------|\n`;
for (const a of audit) md += `| ${a.source}${a.strict ? " *" : ""} | ${a.scanned_at ? a.scanned_at.slice(0, 16).replace("T", " ") : "never"} | ${a.scannedToday ? "✅" : "—"} | ${a.inHyd} | ${a.newToday} | ${a.walled ? (a.strict ? "❌ walled" : "⚠️ walled (info)") : a.scannedToday ? "✅ ok" : a.strict ? "❌ stale" : "⚪ info"} |\n`;
md += `\n**Run verdict:** ${verdict}\n`;
if (finalRows.length) {
  md += `\n### New Hyderabad jobs today\n\n| # | Source | Company — Role | Location | Exp | Link |\n|---|--------|----------------|----------|-----|------|\n`;
  finalRows.forEach((j, i) => { md += `| ${i + 1} | ${j._source}${j._also ? ` +${j._also}` : ""} | ${j.company} — ${j._title} | ${j.location || ""} | ${j.exp || ""} | [open](${j.url || j.apply_url || ""}) |\n`; });
}
writeFileSync(STATUS, md);
try { execFileSync(process.execPath, [join(SCRIPT_DIR, "..", "lib", "funnel-to-xlsx.mjs"), STATUS, XLSX_MD], { stdio: "ignore" }); } catch {}

appendFileSync(AUDIT_LOG, `[${today} ${time}] slot=${sched} sources=${audit.map((a) => `${a.source}:${a.scannedToday ? "fresh" : "STALE"}`).join(",")} new=${finalRows.length} verdict=${runOk ? "OK" : "FAIL"}\n`);
console.error(`${runOk ? "✅" : "❌"} HYDERABAD sheet: ${finalRows.length} new job(s) → ${OUT}`);
console.error(`   ${verdict}`);
process.exit(runOk ? 0 : 1);
