#!/usr/bin/env node
// make-cover-letter.mjs — fill the master cover letter and render text + PDF.
//
// Identity (name / email / phone) and the profile folder come from
// config/profile.json — see config/profile.example.json. Nothing personal is
// hardcoded here.
//
// Source of truth for the prose: <profileDir>/<coverLetterMaster>  (edit content there)
// Usage:
//   node scripts/resume/make-cover-letter.mjs                       -> generic (no company named)
//   node scripts/resume/make-cover-letter.mjs "Tekion" "DevOps Engineer"
// Output (in <profileDir>):
//   <coverLetterPrefix>.pdf / .txt             (generic, when no args)
//   <coverLetterPrefix>_<Company>.pdf / .txt   (tailored, when company given)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import identity from "../lib/identity.mjs";

const PROFILE = identity.profileDir;
const MASTER = join(PROFILE, identity.coverLetterMaster);

const company = process.argv[2] || "";
const role = process.argv[3] || "DevOps Engineer";

// Pull the letter body (everything from "Dear" onward) out of the master md,
// strip markdown bold so it reads clean as plain text / PDF.
const raw = readFileSync(MASTER, "utf8");
const body = raw.slice(raw.indexOf("Dear Hiring Team"));
const filled = body
  .replace(/\[COMPANY\]/g, company || "your company")
  .replace(/\[ROLE\]/g, role)
  .replace(/\*\*/g, "")
  .trim();

const slug = company.replace(/[^A-Za-z0-9]+/g, "") || null;
const base = slug ? `${identity.coverLetterPrefix}_${slug}` : identity.coverLetterPrefix;
const contact = [identity.email, identity.phone].filter(Boolean);

// Plain-text version (for paste-into-a-textbox application forms).
const txt = `${identity.fullName}\n${contact.join(" | ")}\n\n` + filled + "\n";
writeFileSync(join(PROFILE, `${base}.txt`), txt);

// PDF version (for upload). Rendered with Playwright (already a project dep).
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { margin: 25mm 22mm; }
  body { font-family: Georgia, "Times New Roman", serif; font-size: 11.5pt; line-height: 1.55; color: #1a1a1a; }
  .name { font-size: 16pt; font-weight: 700; margin: 0; }
  .contact { color: #555; font-size: 10pt; margin: 2px 0 18px; }
  hr { border: none; border-top: 1px solid #ccc; margin: 0 0 18px; }
  p { margin: 0 0 12px; }
</style></head><body>
  <p class="name">${identity.fullName}</p>
  <p class="contact">${contact.join(" &nbsp;·&nbsp; ")}</p>
  <hr/>
  ${filled.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`).join("\n")}
</body></html>`;

const { chromium } = await import("playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
await page.pdf({ path: join(PROFILE, `${base}.pdf`), format: "A4", printBackground: true });
await browser.close();

console.log(`✅ ${base}.pdf + ${base}.txt -> ${PROFILE}` + (company ? ` (tailored for ${company})` : " (generic)"));
