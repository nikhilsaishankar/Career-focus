#!/usr/bin/env node
// build-resume.mjs — fill templates/cv-template.html from a content JSON.
//
// Usage: node build-resume.mjs <content.json> <output.html>
//
// The content JSON carries ONLY real CV content (no invented skills); per-job
// tailoring is just reordering/emphasis. Empty sections (e.g. certifications)
// are removed automatically.

import { readFileSync, writeFileSync } from "node:fs";

const [, , contentPath, outPath] = process.argv;
if (!contentPath || !outPath) {
  console.error("Usage: node build-resume.mjs <content.json> <output.html>");
  process.exit(1);
}

const c = JSON.parse(readFileSync(contentPath, "utf8"));
let tpl = readFileSync("templates/cv-template.html", "utf8");

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Like esc(), but also turns **inline** markers into <strong> (for bolding tech
// keywords / metrics inside bullets, summary, and project descriptions).
const rich = (s) =>
  esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

const competencies = (c.competencies || [])
  .map((t) => `<span class="competency-tag">${esc(t)}</span>`)
  .join("\n      ");

const experience = (c.experience || [])
  .map(
    (j) => `    <div class="job">
      <div class="job-header">
        <span class="job-company">${esc(j.company)}</span>
        <span class="job-period">${esc(j.period)}</span>
      </div>
      <div class="job-role">${esc(j.role)}${j.location ? ` <span class="job-location">· ${esc(j.location)}</span>` : ""}</div>
      <ul>
        ${(j.bullets || []).map((b) => `<li>${rich(b)}</li>`).join("\n        ")}
      </ul>
    </div>`,
  )
  .join("\n");

const projects = (c.projects || [])
  .map(
    (p) => `    <div class="project">
      <span class="project-title">${esc(p.title)}</span>${p.badge ? `<span class="project-badge">${esc(p.badge)}</span>` : ""}
      <div class="project-desc">${rich(p.desc)}</div>${p.tech ? `\n      <div class="project-tech">${esc(p.tech)}</div>` : ""}
    </div>`,
  )
  .join("\n");

const education = (c.education || [])
  .map(
    (e) => `    <div class="edu-item">
      <div class="edu-header">
        <span class="edu-title">${esc(e.title)} <span class="edu-org">· ${esc(e.org)}</span></span>
        <span class="edu-year">${esc(e.year)}</span>
      </div>${e.desc ? `\n      <div class="edu-desc">${esc(e.desc)}</div>` : ""}
    </div>`,
  )
  .join("\n");

const certifications = (c.certifications || [])
  .map(
    (x) => `    <div class="cert-item">
      <span class="cert-title">${esc(x.title)}</span>
      <span class="cert-org">${esc(x.org)}</span>
      <span class="cert-year">${esc(x.year)}</span>
    </div>`,
  )
  .join("\n");

const skills = (c.skills || [])
  .map(
    (s) =>
      `      <div class="skill-item"><span class="skill-category">${esc(s.category)}:</span> ${esc((s.items || []).join(", "))}</div>`,
  )
  .join("\n");

const map = {
  LANG: c.lang || "en",
  PAGE_WIDTH: c.page_width || "210mm",
  NAME: esc(c.name),
  PHONE: esc(c.phone),
  EMAIL: esc(c.email),
  LINKEDIN_URL: c.linkedin_url || "#",
  LINKEDIN_DISPLAY: esc(c.linkedin_display || ""),
  PORTFOLIO_URL: c.portfolio_url || "#",
  PORTFOLIO_DISPLAY: esc(c.portfolio_display || ""),
  LOCATION: esc(c.location),
  SECTION_SUMMARY: "Professional Summary",
  SUMMARY_TEXT: rich(c.summary),
  SECTION_COMPETENCIES: "Core Competencies",
  COMPETENCIES: competencies,
  SECTION_EXPERIENCE: "Work Experience",
  EXPERIENCE: experience,
  SECTION_PROJECTS: "Projects",
  PROJECTS: projects,
  SECTION_EDUCATION: "Education",
  EDUCATION: education,
  SECTION_CERTIFICATIONS: "Certifications",
  CERTIFICATIONS: certifications,
  SECTION_SKILLS: "Technical Skills",
  SKILLS: skills,
};

for (const [k, v] of Object.entries(map)) {
  tpl = tpl.replaceAll(`{{${k}}}`, v);
}

// Drop sections whose content is empty (e.g. certifications, projects).
tpl = tpl.replace(
  /\s*<!-- [A-Z ]+ -->\s*<div class="section[^"]*">\s*<div class="section-title">[^<]*<\/div>\s*(?:<div class="competencies-grid">\s*<\/div>\s*)?<\/div>/g,
  "",
);

writeFileSync(outPath, tpl);
console.log(`✅ ${outPath}`);
