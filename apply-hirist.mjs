#!/usr/bin/env node
// apply-hirist.mjs — supervised, SHORTLIST-DRIVEN auto-apply on Hirist.
//
// Applies ONLY to the 🟢 jobs on the sheet (pass===true / status 🟢, not yet applied) — never
// anything you didn't shortlist. Hirist gives each job its own URL, so the agent navigates
// straight to each 🟢 job and clicks Apply (your already-updated account résumé attaches).
//
// SUBMITS real applications, but ONLY true one-click applies. If Hirist shows screening
// questions, it does NOT submit: captures them to data/apply-questions.md and marks 🟠.
//
//   node apply-hirist.mjs --dry     # navigate + locate Apply for the first 🟢, DON'T click
//   node apply-hirist.mjs --test    # apply to ONE 🟢 job (you watch)
//   node apply-hirist.mjs           # apply to all 🟢 Hirist jobs
//
// Marks 🔵 Applied back into data/hirist-scan.json (so build-workbook shows it) + applied-log.tsv.

import { chromium } from "playwright";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".career-ops", "hirist-chrome-profile");
const SCAN = "data/hirist-scan.json";
const QLOG = "data/apply-questions.md";
const APPLIED_LOG = "data/applied-log.tsv";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const TEST = args.includes("--test");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync("data/.dispatch", { recursive: true });

if (!existsSync(SCAN)) { console.error(`✗ ${SCAN} not found`); process.exit(1); }
const data = JSON.parse(readFileSync(SCAN, "utf8"));
let targets = (data.jobs || []).filter((j) => (j.pass === true || /🟢/.test(j.status || "")) && !j.applied && j.url);
if (targets.length === 0) { console.error("⛔ No 🟢 shortlisted Hirist jobs to apply to. Nothing to do."); process.exit(0); }
if (DRY || TEST) targets = targets.slice(0, 1);
console.error(`🎯 ${targets.length} 🟢 Hirist job(s) to apply to`);

function record(job, applied, questions) {
  const date = new Date().toISOString().slice(0, 10);
  // Keep the ATS Status (🟢) untouched; the new "Applied" column carries the apply state.
  if (applied) { job.applied = true; job.applied_at = date; }
  else { job.applied = false; job.questions = questions || []; }
  writeFileSync(SCAN, JSON.stringify(data, null, 2));
  appendFileSync(APPLIED_LOG, `${date}\tHirist\t${job.company}\t${job.title}\t${applied ? "APPLIED" : "questions-skipped"}\n`);
  if (!applied && questions?.length) {
    let b = `\n## Hirist · ${job.company} — ${job.title} · ${date}\n`;
    questions.forEach((q, i) => (b += `${i + 1}. ${q}\n`));
    appendFileSync(QLOG, b + "\n_Answer these and I'll automate them next time._\n");
  }
}

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false, channel: "chrome", viewport: { width: 1366, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
const page = ctx.pages()[0] || (await ctx.newPage());

let applied = 0, held = 0, failed = 0;
try {
  for (const job of targets) {
    console.error(`\n▶ ${job.ats || "?"}% · ${job.company} — ${job.title}`);
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(3000);
    if (/login/i.test(page.url())) { console.error("  ✗ not logged in — run `node scan-hirist.mjs --login`"); failed++; break; }

    // Locate the Apply button.
    const found = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((b) => /^apply$/i.test((b.textContent || "").trim()));
      if (!btn) return false;
      btn.setAttribute("data-apply-target", "1");
      btn.scrollIntoView({ block: "center" });
      return true;
    });
    if (!found) { console.error("  ✗ no Apply button (may already be applied / external). Skipping."); failed++; continue; }

    if (DRY) {
      await page.screenshot({ path: "data/.dispatch/hirist-dry.png" }).catch(() => {});
      console.error("  🔍 DRY RUN — Apply button LOCATED ✅ (not clicked). Screenshot: data/.dispatch/hirist-dry.png");
      break;
    }

    await page.click('[data-apply-target="1"]').catch(() => {});
    await sleep(2800);

    // Questions form vs applied confirmation?
    const outcome = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const modal = document.querySelector('[class*="modal" i], [role="dialog"], form[class*="apply" i], [class*="question" i]');
      const inputs = modal ? [...modal.querySelectorAll("textarea, input[type=text], input[type=number], select, input[type=radio]")] : [];
      const questions = modal ? [...modal.querySelectorAll("label, p, h3, h4, legend")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter((t) => t.length > 8 && /\?|experience|notice|salary|why|relocat|years|current ctc|expected/i.test(t)).slice(0, 12) : [];
      const appliedNow = /applied|application (sent|submitted)|successfully applied|you have applied/i.test(body) && inputs.length === 0;
      return { hasQuestions: inputs.length > 0, questions, appliedNow };
    });

    if (outcome.hasQuestions) {
      console.error(`  ⏸ ${outcome.questions.length} question(s) — NOT submitting, captured.`);
      await page.screenshot({ path: `data/.dispatch/hirist-questions-${job.id}.png` }).catch(() => {});
      record(job, false, outcome.questions);
      held++;
      await page.keyboard.press("Escape").catch(() => {});
    } else {
      console.error("  ✅ applied (single-click).");
      record(job, true);
      applied++;
    }
    await sleep(1500);
  }
} catch (e) {
  console.error("⚠️ ", e.message);
} finally {
  await sleep(2000);
  await ctx.close();
}
console.error(`\n✅ Hirist apply done — ${applied} applied · ${held} held for questions · ${failed} skipped.`);
console.error("   run: node build-workbook.mjs   (sheet shows 🔵 Applied / 🟠 questions)");
process.exit(0);
