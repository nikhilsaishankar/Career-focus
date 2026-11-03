#!/usr/bin/env node
// naukri-text-keywords.mjs — pack keywords into the Resume Headline + Profile Summary.
//
// Naukri indexes the Headline and Profile Summary for recruiter search, and these are
// plain TEXTAREAS (reliably editable) — unlike the Key Skills chip box (autocomplete,
// not automatable). So we carry the keyword load here. All text is truthful to cv.md.
//
//   node naukri-text-keywords.mjs --visible   # watch it
//   node naukri-text-keywords.mjs             # headless

import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".career-ops", "naukri-chrome-profile");
const VISIBLE = process.argv.includes("--visible");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

// ~240 chars — keyword-rich but readable (recruiter-visible)
const HEADLINE =
  "DevOps Engineer | 3.7 yrs | CI/CD Pipeline Automation with Jenkins | Docker, Docker Compose, Kubernetes | AWS EC2/ECR/ECS/IAM | Git Flow, GitHub, GitLab CI/CD | Linux, SonarQube, Maven | Deployment Automation & Containerization";

// Keyword-dense, truthful prose summary (all skills are on cv.md)
const SUMMARY =
  "DevOps Engineer with 3.7+ years of experience in CI/CD pipeline automation, Docker containerization, and AWS cloud infrastructure across product companies. Skilled in designing multi-stage Jenkins Declarative Pipelines that automate build, test, and deployment end-to-end. Hands-on with Docker (Dockerfile, Docker Compose, Docker Networking, Docker Swarm, Docker Hub), Kubernetes (Pods, Deployments, Services), and AWS services including EC2, ECR, ECS, IAM, and Security Groups. Experienced with Git, GitHub, GitLab CI/CD, and Git Flow branching strategy across multi-developer teams, plus SonarQube and Maven for build quality. Strong in Linux server administration, deployment automation, release management, and containerization for scalable, reliable software delivery.";

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: !VISIBLE, channel: "chrome", viewport: { width: 1366, height: 980 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
});
const page = ctx.pages()[0] || (await ctx.newPage());

// open an editable section by its heading text, click its edit pencil
async function openEditor(headingRe) {
  return page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, "i");
    const heads = [...document.querySelectorAll("span,h2,h3,div,label")].filter(
      (n) => re.test((n.textContent || "").trim()) && (n.textContent || "").trim().length < 30);
    for (const h of heads) {
      let card = h.parentElement;
      for (let i = 0; i < 6 && card; i++) {
        const ed = card.querySelector(".edit.icon, em.icon.edit, span.edit, em.edit");
        if (ed) { ed.scrollIntoView({ block: "center" }); ed.click(); return true; }
        card = card.parentElement;
      }
    }
    return false;
  }, headingRe);
}

// fill the visible textarea in the open drawer and click its Save
async function fillDrawerTextarea(text) {
  const ta = page.locator(".profileEditDrawer textarea, .drawer textarea, textarea:visible").first();
  await ta.waitFor({ timeout: 8000 });
  await ta.fill(text);
  await sleep(600);
  const drawer = page.locator(".profileEditDrawer").filter({ has: page.locator("textarea") });
  const btn = (await drawer.count()) ? drawer.locator("button[type=submit]").first()
                                     : page.locator("button[type=submit]:visible").last();
  await btn.click({ timeout: 6000 });
  await sleep(3500);
}

let headlineOk = false, summaryOk = false;
try {
  await page.goto("https://www.naukri.com/mnjuser/profile", { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await sleep(4000);
  if (!/mnjuser\/profile/.test(page.url())) throw new Error("not logged in — run `node scan-naukri.mjs --login`");
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 1100); await sleep(300); }
  await sleep(1200);

  // 1) Resume Headline (proven path: #resumeHeadlineTxt)
  try {
    if (await openEditor("^resume headline$")) {
      await page.waitForSelector("#resumeHeadlineTxt", { timeout: 8000 });
      await page.locator("#resumeHeadlineTxt").fill(HEADLINE);
      await sleep(500);
      const d = page.locator(".profileEditDrawer").filter({ has: page.locator("#resumeHeadlineTxt") });
      await d.locator("button[type=submit]").first().click({ timeout: 6000 });
      await sleep(3500);
      headlineOk = true; log("✅ Resume Headline updated.");
    } else log("⚠️ headline editor not found");
  } catch (e) { log("⚠️ headline: " + e.message); }

  // 2) Profile Summary
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 900); await sleep(250); }
  try {
    if (await openEditor("^profile summary$")) {
      await fillDrawerTextarea(SUMMARY);
      summaryOk = true; log("✅ Profile Summary updated.");
    } else log("⚠️ profile summary editor not found");
  } catch (e) { log("⚠️ summary: " + e.message); }

  // read-back
  await page.reload({ waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await sleep(3000);
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 1000); await sleep(250); }
  const body = await page.evaluate(() => document.body.innerText);
  log("read-back — headline present: " + /CI\/CD Pipeline Automation with Jenkins/.test(body));
  log("read-back — summary present:  " + /3\.7\+ years of experience in CI\/CD/.test(body));
} catch (e) {
  log("❌ " + e.message);
} finally {
  log(`headline: ${headlineOk ? "ok" : "no"} | summary: ${summaryOk ? "ok" : "no"}`);
  await ctx.close();
}
