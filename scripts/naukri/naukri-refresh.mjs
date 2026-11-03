#!/usr/bin/env node
// naukri-refresh.mjs — keep your Naukri profile at the top of recruiter searches.
//
// Naukri ranks by profile freshness. This re-uploads your standard resume (refreshes the
// "Resume uploaded" date) AND, as a fallback, re-saves the Resume Headline (refreshes
// "Profile last updated"). Either bumps you to the top. Uses the saved logged-in session.
//
//   PRIMARY:  re-upload RESUME_PATH to the #attachCV input as UPLOAD_NAME → "Uploaded on" = today.
//   FALLBACK: if the upload control isn't rendered (Naukri serves a degraded page to
//             headless sometimes), re-save the headline so the run still bumps freshness.
//
// Usage:
//   node naukri-refresh.mjs            # headless (for the 6-9am schedule)
//   node naukri-refresh.mjs --visible  # show the browser

import { chromium } from "playwright";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, writeFileSync, appendFileSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { reportPaths } from "../lib/reports-paths.mjs";
import identity from "../lib/identity.mjs";

const PROFILE_DIR = join(homedir(), ".career-ops", "naukri-chrome-profile");
const RESUME_PATH = identity.resumePath; // base résumé — set "resumePath" in config/profile.json
// Naukri shows the uploaded file's own name to recruiters, and re-uploading the same
// basename makes it serve back numbered copies ("...Resume(1).pdf"). So we always
// upload the bytes under this exact, fixed name — never the on-disk basename.
const UPLOAD_NAME = identity.naukriUploadName; // set "naukriUploadName" in config/profile.json
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RP = reportPaths(); // reports_stats/<YYYY-MM-DD>/
const STATUS = RP.md("module05-Naukri-Profile.md"); // .md source (date folder)
const XLSX_OUT = RP.xlsx("NAUKRI.xlsx"); // Excel in date folder (renamed from module05-Naukri-Profile.xlsx per user 2026-07-18: date folder = HYDERABAD/MASTER/NAUKRI only)
const VISIBLE = process.argv.includes("--visible");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

const readStamp = (page) =>
  page.evaluate(() => {
    const pick = (re) => {
      const n = [...document.querySelectorAll("*")].find(
        (e) => re.test(e.textContent || "") && (e.textContent || "").length < 60,
      );
      return n ? n.textContent.replace(/\s+/g, " ").trim() : "";
    };
    return { updated: pick(/profile last updated/i), uploaded: pick(/uploaded on/i) };
  });

if (!existsSync(RESUME_PATH)) log("⚠️  resume not found at " + RESUME_PATH + " (will fall back to headline)");

// The scanner (scan-naukri.mjs) shares this Chrome profile, and a run killed
// mid-sleep leaves a stale SingletonLock behind — both made launch die with
// "Failed to create a ProcessSingleton" (the near-daily FAIL exit=1 slots).
// So: if another process is live on the profile, wait for it; if not, clear
// stale Singleton* files; retry for up to ~10 min before giving up.
async function launchWithProfileRetry() {
  for (let attempt = 1; attempt <= 20; attempt++) {
    let busy = true;
    try { execFileSync("pgrep", ["-f", `user-data-dir=${PROFILE_DIR}`]); } catch { busy = false; }
    if (!busy) {
      for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        try { unlinkSync(join(PROFILE_DIR, f)); } catch {}
      }
      try {
        return await chromium.launchPersistentContext(PROFILE_DIR, {
          headless: !VISIBLE,
          channel: "chrome",
          viewport: { width: 1366, height: 980 },
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        });
      } catch (e) {
        if (!/ProcessSingleton|SingletonLock/i.test(String(e))) throw e;
        log(`⚠️ launch attempt ${attempt}: profile lock race — retrying in 30s`);
      }
    } else {
      log(`⏳ profile in use by another Chrome (likely scan-naukri) — waiting 30s (${attempt}/20)`);
    }
    await sleep(30000);
  }
  throw new Error("naukri chrome profile locked for >10 min — giving up this attempt");
}
const ctx = await launchWithProfileRetry();
const page = ctx.pages()[0] || (await ctx.newPage());

let method = "none", ok = false, before = {}, after = {}, failReason = "";
try {
  await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await sleep(4000);
  if (!/mnjuser\/profile/.test(page.url())) throw new Error("not logged in — run `node scan-naukri.mjs --login`");
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1300); await sleep(400); }
  await sleep(1500);
  before = await readStamp(page);

  // ---- PRIMARY: re-upload the resume ----
  const cv = page.locator("#attachCV");
  if (existsSync(RESUME_PATH) && (await cv.count()) > 0) {
    await cv.setInputFiles({
      name: UPLOAD_NAME,
      mimeType: "application/pdf",
      buffer: readFileSync(RESUME_PATH),
    });
    // wait for Naukri to process: "Uploaded on <today>" or a success toast
    const todayMon = new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit" }); // e.g. "Jun 14"
    try {
      await page.waitForFunction(
        (mon) => /successfully|resume has been/i.test(document.body.innerText) || document.body.innerText.includes(mon),
        todayMon,
        { timeout: 25000 },
      );
    } catch { /* proceed to verify via stamp */ }
    await sleep(2500);
    method = "resume re-upload";
    ok = true;
  } else {
    // ---- FALLBACK: re-save the resume headline ----
    const clicked = await page.evaluate(() => {
      const heads = [...document.querySelectorAll("span,h2,h3,div,label")].filter(
        (n) => /^resume headline$/i.test((n.textContent || "").trim()),
      );
      for (const h of heads) {
        let card = h.parentElement;
        for (let i = 0; i < 6 && card; i++) {
          const ed = card.querySelector(".edit.icon, em.icon.edit, span.edit, em.edit");
          if (ed) { ed.scrollIntoView({ block: "center" }); ed.click(); return true; }
          card = card.parentElement;
        }
      }
      return false;
    });
    if (!clicked) throw new Error("neither resume-upload control (#attachCV) nor headline editor found");
    await page.waitForSelector("#resumeHeadlineTxt", { timeout: 10000 });
    const ta = page.locator("#resumeHeadlineTxt");
    const base = (await ta.inputValue()).replace(/\s+$/, "");
    await ta.fill(base + " ");
    const drawer = page.locator(".profileEditDrawer").filter({ has: page.locator("#resumeHeadlineTxt") });
    await drawer.locator("button[type=submit]").first().click({ timeout: 6000 });
    await sleep(3500);
    method = "headline re-save (fallback)";
    ok = true;
  }

  after = await readStamp(page);
} catch (e) {
  failReason = e.message.replace(/[\t\n|]+/g, " ").trim();
  log("⚠️  " + e.message);
} finally {
  await ctx.close();
}

log(`method: ${method}`);
log(`before: updated="${before.updated || "?"}"  uploaded="${before.uploaded || "?"}"`);
log(`after:  updated="${after.updated || "?"}"  uploaded="${after.uploaded || "?"}"`);
log(ok ? "✅ profile refreshed (now on top)" : "❌ refresh failed");

// Record this run, then rebuild a per-day SLOT-STATUS view: each slot ticks ✅ Done when
// its scheduled runs have all fired, plus an Overall row. Raw runs live in a hidden tsv.
const upDate = (s) => (s.match(/uploaded on ([a-z]{3} \d{1,2})/i) || [])[1] || "?";
const now = new Date();
const hour = now.getHours();
const slot = hour < 12 ? "🌅 Morning" : hour < 21 ? "☀️ Afternoon" : "🌙 Night";
// LOCAL date (same as the scratch folder) — toISOString() is UTC and shifted every
// run before 05:30 IST into the previous day's table.
const dateStr = RP.date;
const time = now.toTimeString().slice(0, 5);
const upd = `${upDate(before.uploaded || "")} → ${upDate(after.uploaded || "")}`;
// Authoritative scheduled slot: the strict runner exports NAUKRI_SLOT (the hour launchd
// fired for, even when the Mac woke late). Fallback: floor of the run hour — same as the
// runner's own `date +%H` — never "nearest slot", which credited late runs to the wrong hour.
const schedSlot = process.env.NAUKRI_SLOT || `${String(hour).padStart(2, "0")}:00`;

mkdirSync(dirname(STATUS), { recursive: true });
const RUNS = RP.md(".module05-runs.tsv"); // per-date raw run log (date folder)
appendFileSync(RUNS, `${dateStr}\t${slot}\t${time}\t${upd}\t${ok ? "OK" : "FAIL"}\t${failReason}\t${schedSlot}\n`);

// The 24 scheduled slot times (STRICT: every hour, per user 2026-07-16), by phase.
// Each becomes a row; it gets ✅ + the actual "Ran at" time once that refresh fires, else ⏳ pending.
const SCHEDULE = Array.from({ length: 24 }, (_, h) => {
  const phase = h < 12 ? "🌅 Morning" : h < 21 ? "☀️ Afternoon" : "🌙 Night";
  return [phase, `${String(h).padStart(2, "0")}:00`];
});
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
// Match an actual run to the nearest scheduled slot (within 25 min — slots are hourly,
// so a wider window would let a late retry claim the NEXT slot); off-schedule = ignore.
const nearestIdx = (mins) => {
  let best = -1, bd = Infinity;
  SCHEDULE.forEach(([, t], i) => { const d = Math.abs(toMin(t) - mins); if (d < bd) { bd = d; best = i; } });
  return bd <= 25 ? best : -1;
};
const log_rows = readFileSync(RUNS, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const byDate = {};
for (const [d, , t, , st, why, sched] of log_rows) {
  // Prefer the recorded scheduled slot (column 7); legacy rows fall back to nearest-time.
  const i = sched ? SCHEDULE.findIndex(([, s]) => s === sched) : nearestIdx(toMin(t));
  if (i < 0) continue;
  (byDate[d] ||= {});
  // A slot may get several attempts (strict runner retries): an OK run always beats a
  // FAIL run; among equals, the earliest run wins.
  const cand = { t, ok: st === "OK", why: why || "" };
  const cur = byDate[d][i];
  if (!cur || (cand.ok && !cur.ok) || (cand.ok === cur.ok && t < cur.t)) byDate[d][i] = cand;
}
const todayStr = dateStr;
const nowMin = toMin(time);
byDate[todayStr] ||= {}; // always render today, even if the current run was off-schedule
let md =
  "# Module 05 — Naukri Profile Refresh\n\n" +
  "STRICT phase-wise schedule — every hour, round the clock (scheduled pmset wakes fire it while the Mac sleeps; only a full shutdown skips a slot). Each slot shows ✅ + the time it ran. ⏳ pending = still upcoming; ❌ not done = the time passed with no run. Remarks give the reason for any fail/miss. 🌅 12 · ☀️ 9 · 🌙 3 = 24/day.\n" +
  "**Day verdict: ✅ Passed only when ALL 24 slots succeed — any ⚠️ fail or ❌ miss marks the day ❌ Failed.**\n";
for (const d of Object.keys(byDate).sort()) {
  md += `\n## ${d}\n\n| Phase | Scheduled | Ran at | Status | Remarks |\n|-------|-----------|--------|--------|---------|\n`;
  // Day verdict: ✅ Passed ONLY when ALL scheduled slots ran successfully.
  // A ⚠️ fail run or a ❌ missed slot makes Passed impossible → the day is ❌ Failed.
  let done = 0, failed = 0, missed = 0;
  SCHEDULE.forEach(([phase, sched], i) => {
    const r = byDate[d][i];
    let status, remark = "—";
    if (r) {
      if (r.ok) { status = "✅ done"; done++; }
      else { status = "⚠️ fail"; failed++; remark = r.why || "refresh failed (see log)"; }
    } else {
      const passed = d < todayStr || (d === todayStr && toMin(sched) < nowMin);
      if (passed) { status = "❌ not done"; missed++; remark = "no run — Mac off/asleep at slot time"; }
      else status = "⏳ pending";
    }
    md += `| ${phase} | ${sched} | ${r ? r.t : "—"} | ${status} | ${remark} |\n`;
  });
  const detail = [failed && `${failed} fail`, missed && `${missed} missed`].filter(Boolean).join(" · ");
  const overall =
    done >= SCHEDULE.length ? "✅ Passed — all slots done"
    : failed || missed ? `❌ Failed — ${done}/${SCHEDULE.length} done${detail ? " · " + detail : ""}`
    : `⏳ In progress — ${done}/${SCHEDULE.length} done`;
  md += `| 📋 Overall | — | — | ${overall} | ${detail || "—"} |\n`;
}
writeFileSync(STATUS, md);
// Render the Excel view (best-effort — never fail the refresh over it).
try {
  execFileSync(process.execPath, [join(SCRIPT_DIR, "..", "lib", "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" });
} catch {}
log(`📝 logged to ${STATUS} (+ .xlsx)`);
process.exit(ok ? 0 : 1);
