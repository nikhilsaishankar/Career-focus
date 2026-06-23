#!/usr/bin/env node
// apply-instahyre.mjs — supervised auto-apply on Instahyre for PASSING jobs (🟢, ATS ≥ 75).
//
// IMPORTANT: this SUBMITS real applications — but ONLY true one-click applies. If Instahyre
// shows screening questions, it does NOT submit: it captures the questions, marks the job
// "not applied (questions)", and logs them to data/apply-questions.md for you to answer.
// Your account résumé (already updated on Instahyre) is what gets attached — no upload here.
//
// Runs VISIBLE by default (Instahyre serves a degraded page headless, and you want to watch).
//
//   node apply-instahyre.mjs --test        # apply to ONE matching job, you watch (default 1)
//   node apply-instahyre.mjs               # apply to all 🟢 Instahyre jobs (after you trust it)
//   node apply-instahyre.mjs --company "X" # target a specific company's card
//
// Marks applied jobs back into data/instahyre-scan.json (status 🔵 Applied) so build-workbook
// shows them, and appends to data/applied-log.tsv.

import { chromium } from "playwright";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".career-ops", "instahyre-chrome-profile");
const FEED = "https://www.instahyre.com/candidate/opportunities/?matching=true";
const SCAN = "data/instahyre-scan.json";
const QLOG = "data/apply-questions.md";
const APPLIED_LOG = "data/applied-log.tsv";

const args = process.argv.slice(2);
const TEST = args.includes("--test");
const DRY = args.includes("--dry"); // locate the target + Apply button, but DO NOT click/submit
const COMPANY = (args.find((a) => a.startsWith("--company")) ? args[args.indexOf("--company") + 1] : null);
const MAX = TEST || DRY ? 1 : 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEVOPS = /dev[\s-]?(sec[\s-]?)?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure|cloud\s*(eng|ops)|release\s*eng|kubernetes|\bk8s\b/i;

function markApplied(company, title, applied, questions) {
  const date = new Date().toISOString().slice(0, 10);
  // record into the scan JSON if the job is there (so the workbook reflects it)
  if (existsSync(SCAN)) {
    try {
      const d = JSON.parse(readFileSync(SCAN, "utf8"));
      let j = (d.jobs || []).find((x) => (x.company || "").toLowerCase() === company.toLowerCase());
      if (!j) { (d.jobs = d.jobs || []).push(j = { id: `apply-${Date.now()}`, company, title, url: FEED }); }
      if (applied) { j.applied = true; j.applied_at = date; } // Status stays 🟢; Applied column carries state
      else { j.applied = false; j.questions = questions || []; }
      writeFileSync(SCAN, JSON.stringify(d, null, 2));
    } catch {}
  }
  appendFileSync(APPLIED_LOG, `${date}\tInstahyre\t${company}\t${title}\t${applied ? "APPLIED" : "questions-skipped"}\n`);
  if (!applied && questions && questions.length) {
    let block = `\n## Instahyre · ${company} — ${title} · ${date}\n`;
    questions.forEach((q, i) => (block += `${i + 1}. ${q}\n`));
    block += `\n_Answer these and I'll automate them next time._\n`;
    appendFileSync(QLOG, block);
  }
}

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false, channel: "chrome", viewport: { width: 1366, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
const page = ctx.pages()[0] || (await ctx.newPage());

// SHORTLIST-DRIVEN: build the target set = 🟢 jobs from the sheet (pass===true / status 🟢),
// not yet applied. The agent applies ONLY to these. No 🟢 → no action (the correct behavior).
let TARGETS = [];
if (existsSync(SCAN)) {
  try {
    const d = JSON.parse(readFileSync(SCAN, "utf8"));
    TARGETS = (d.jobs || [])
      .filter((j) => (j.pass === true || /🟢/.test(j.status || "")) && !j.applied)
      .map((j) => (j.company || "").toLowerCase()).filter(Boolean);
  } catch {}
}
if (COMPANY) TARGETS = [COMPANY.toLowerCase()]; // explicit override
if (TARGETS.length === 0) {
  console.error("⛔ No 🟢 shortlisted Instahyre jobs to apply to (nothing marked Ready on the sheet). Nothing to do.");
  await ctx.close();
  process.exit(0);
}
console.error(`🎯 shortlist: ${TARGETS.length} 🟢 job(s) to apply to → ${TARGETS.join(", ")}`);

let applied = 0, skipped = 0;
try {
  await page.goto(FEED, { waitUntil: "networkidle", timeout: 60000 });
  await sleep(5000);
  if (/login/i.test(page.url())) throw new Error("not logged in — run `node scan-instahyre.mjs --login` first.");

  for (let n = 0; n < MAX; n++) {
    // Find an Apply card whose company is on the 🟢 shortlist (and matches DevOps).
    const card = await page.evaluate(({ targets, devSrc }) => {
      const DEV = new RegExp(devSrc, "i");
      const applyBtns = [...document.querySelectorAll("button, a")].filter((b) => /^apply$/i.test((b.textContent || "").trim()));
      for (const btn of applyBtns) {
        let c = btn; for (let i = 0; i < 8 && c.parentElement; i++) c = c.parentElement;
        const txt = c.innerText || "";
        const lines = txt.split("\n").map((s) => s.trim()).filter(Boolean);
        const title = lines.find((l) => DEV.test(l)) || lines[0] || "";
        const company = (c.querySelector('[class*="company" i], [class*="employer" i]') || {}).textContent?.trim()
          || lines[1] || "";
        if (!DEV.test(title)) continue;
        // STRICT: only a card whose company is on the 🟢 shortlist.
        if (!targets.some((t) => company.toLowerCase().includes(t) || t.includes(company.toLowerCase()))) continue;
        btn.setAttribute("data-apply-target", "1");
        return { company, title };
      }
      return null;
    }, { targets: TARGETS, devSrc: DEVOPS.source });

    if (!card) { console.error("  no shortlisted (🟢) Apply card found on the feed."); break; }
    console.error(`\n▶ ${card.company} — ${card.title}`);

    if (DRY) {
      // Prove targeting without submitting: confirm the Apply button is located, scroll to it.
      const found = await page.evaluate(() => !!document.querySelector('[data-apply-target="1"]'));
      await page.evaluate(() => document.querySelector('[data-apply-target="1"]')?.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: "data/.dispatch/instahyre-dry.png" }).catch(() => {});
      console.error(`  🔍 DRY RUN — Apply button ${found ? "LOCATED ✅ (not clicked)" : "NOT found ✗"}. Screenshot: data/.dispatch/instahyre-dry.png`);
      break;
    }

    await page.click('[data-apply-target="1"]').catch(() => {});
    await sleep(2500);

    // Detect: did a questions form/modal appear, or did it confirm applied?
    const outcome = await page.evaluate(() => {
      const body = document.body.innerText || "";
      const modal = document.querySelector('[class*="modal" i], [role="dialog"], [class*="question" i]');
      const inputs = modal ? [...modal.querySelectorAll("textarea, input[type=text], select, input[type=radio]")] : [];
      const questions = modal ? [...modal.querySelectorAll("label, p, h3, h4")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter((t) => t.length > 8 && /\?|experience|notice|salary|why|relocat|years/i.test(t)).slice(0, 10) : [];
      const appliedNow = /applied|application sent|we.{0,5}ll notify|thank you for applying|interest sent/i.test(body) && inputs.length === 0;
      return { hasQuestions: inputs.length > 0, questions, appliedNow };
    });

    if (outcome.hasQuestions) {
      console.error(`  ⏸ questions detected (${outcome.questions.length}) — NOT submitting, captured for you.`);
      await page.screenshot({ path: `data/.dispatch/instahyre-questions-${Date.now()}.png` }).catch(() => {});
      markApplied(card.company, card.title, false, outcome.questions);
      skipped++;
      // close the modal without submitting
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(1000);
    } else {
      console.error("  ✅ applied (single-click).");
      markApplied(card.company, card.title, true);
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

console.error(`\n✅ Instahyre apply run done — ${applied} applied, ${skipped} held for questions.`);
console.error(`   sheet: build-workbook will show 🔵 Applied / 🟠 questions. log: ${APPLIED_LOG}`);
process.exit(0);
