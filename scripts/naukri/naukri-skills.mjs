#!/usr/bin/env node
// naukri-skills.mjs — ADD known key skills to your Naukri profile (additive, never deletes).
//
// Naukri ranks profiles partly on Key Skills match against recruiter searches. This adds
// every skill Nikhil genuinely has (from cv.md) as a Key Skill keyword, so more recruiter
// searches surface his profile. Uses the saved logged-in Chrome session.
//
// SAFE: only ADDS skills not already present. Never removes existing chips.
//
// Usage:
//   node naukri-skills.mjs --visible   # watch it (recommended first run)
//   node naukri-skills.mjs             # headless

import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".career-ops", "naukri-chrome-profile");
const VISIBLE = process.argv.includes("--visible");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

// Every skill Nikhil actually has (from cv.md). No invented skills; no "learning" items.
const SKILLS = [
  "DevOps", "CI/CD", "CI/CD Pipeline", "Continuous Integration", "Continuous Deployment",
  "Deployment Automation", "Build and Release", "Jenkins", "Jenkins Declarative Pipeline",
  "Maven", "SonarQube", "Docker", "Dockerfile", "Docker Compose", "Docker Networking",
  "Docker Swarm", "Containerization", "Kubernetes", "AWS", "Amazon EC2", "Amazon ECR",
  "Amazon ECS", "AWS IAM", "Git", "GitHub", "Git Flow", "Branching Strategy", "Linux",
  "Agile", "Jira",
  // second pass — additional skills genuinely on his CV/projects (2026-06-15)
  "GitLab", "GitLab CI/CD", "AWS Security Groups", "Nginx", "Apache HTTP Server",
  "Docker Hub", "Source Code Management", "Release Management", "Pull Requests",
  "Cloud Computing", "Infrastructure Management", "Pipeline Automation",
];

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: !VISIBLE,
  channel: "chrome",
  viewport: { width: 1366, height: 980 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
});
const page = ctx.pages()[0] || (await ctx.newPage());

let added = [], present = [], failedSkills = [], failed = false;
try {
  await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await sleep(4000);
  if (!/mnjuser\/profile/.test(page.url())) throw new Error("not logged in — run `node scan-naukri.mjs --login`");

  // Scroll so the Key Skills widget renders
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 1100); await sleep(350); }
  await sleep(1500);

  // 1) Open the Key Skills editor. Find the "Key skills" heading, then its edit pencil.
  const opened = await page.evaluate(() => {
    const heads = [...document.querySelectorAll("*")].filter(
      (e) => /^key\s*skills$/i.test((e.textContent || "").trim()) && (e.textContent || "").trim().length < 20,
    );
    for (const h of heads) {
      // look for an edit icon within the same widget (walk up a few parents)
      let node = h;
      for (let up = 0; up < 4 && node; up++, node = node.parentElement) {
        const edit = node.querySelector(
          'span.edit, .edit.icon, .icon.edit, [class*="edit"], .editOneTheme',
        );
        if (edit) { edit.click(); return true; }
      }
    }
    return false;
  });
  if (!opened) throw new Error("could not find Key Skills edit control");
  await sleep(2500);

  // 2) Find the skills text input inside the now-open drawer/modal.
  const inputSel = [
    "#keySkillSugg", "#keySkills input", 'input[placeholder*="skill" i]',
    ".chipsContainer input", ".drawer input[type=text]", '.profileEditDrawer input[type="text"]',
  ];
  let input = null;
  for (const s of inputSel) {
    const loc = page.locator(s).first();
    if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) { input = loc; break; }
  }
  if (!input) throw new Error("could not find Key Skills input field");

  // 3) Read existing chips so we only ADD missing ones.
  const existing = (await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.chip, [class*="chip"], .ssc-chip')]
      .map((c) => (c.textContent || "").trim().toLowerCase());
    return chips;
  })) || [];

  for (const skill of SKILLS) {
    if (existing.some((e) => e.includes(skill.toLowerCase()))) { present.push(skill); continue; }
    await input.click();
    await input.fill("");
    await input.type(skill, { delay: 60 });   // type slowly so Naukri fires autocomplete
    await sleep(1400);                          // wait for the suggestion dropdown

    // DROPDOWN-AWARE: click the matching suggestion (free-typed entries get discarded on save)
    const picked = await page.evaluate((sk) => {
      const opts = [...document.querySelectorAll(
        '.sgst li, .Suggestions li, ul[class*="ggest"] li, [class*="suggestion"] li, li[index], .dropdownPrimary li',
      )].filter((o) => o.offsetParent !== null);
      // exact match first, else first option that contains the skill
      const exact = opts.find((o) => (o.textContent || "").trim().toLowerCase() === sk.toLowerCase());
      const partial = opts.find((o) => (o.textContent || "").toLowerCase().includes(sk.toLowerCase()));
      const target = exact || partial;
      if (target) { target.click(); return (target.textContent || "").trim(); }
      return null;
    }, skill);

    if (picked) { added.push(skill); await sleep(500); }
    else {
      // no suggestion offered — Enter as a last resort (may or may not stick)
      await page.keyboard.press("Enter");
      await sleep(500);
      failedSkills.push(skill);
    }
  }

  // 4) Save — the submit button inside the open drawer.
  const saved = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter(
      (b) => /^save$/i.test((b.textContent || "").trim()) && b.offsetParent !== null,
    );
    if (btns.length) { btns[btns.length - 1].click(); return true; }
    return false;
  });
  await sleep(3500);
  log(saved ? "Save clicked." : "⚠️ Save button not found — changes may not persist.");

  // READ-BACK in the same (non-degraded, visible) session to confirm persistence
  await page.reload({ waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await sleep(3000);
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 1100); await sleep(300); }
  const onProfile = await page.evaluate(() => {
    const heads = [...document.querySelectorAll("*")].filter(
      (e) => /^key\s*skills$/i.test((e.textContent || "").trim()) && (e.textContent || "").trim().length < 20);
    for (const h of heads) { let n = h;
      for (let up = 0; up < 6 && n; up++, n = n.parentElement) {
        const chips = [...new Set([...n.querySelectorAll('[class*="chip"]')].map((c) => (c.textContent || "").replace(/×|✕|✖/g, "").trim()).filter((t) => t && t.length < 40))];
        if (chips.length > 3) return chips;
      } }
    return [];
  });
  log(`✅ VERIFIED ON PROFILE (${onProfile.length}): ${onProfile.join(", ")}`);
} catch (e) {
  failed = true;
  log("❌ " + e.message);
} finally {
  log(`already present: ${present.length} | added via dropdown: ${added.length} | no-suggestion: ${failedSkills.length}`);
  if (added.length) log("added: " + added.join(", "));
  if (failedSkills.length) log("no dropdown match (skipped): " + failedSkills.join(", "));
  await ctx.close();
  if (failed) process.exit(2);
}
