#!/usr/bin/env node
// build-resume.mjs — fill templates/cv-template.html from a content JSON.
//
// Usage: node build-resume.mjs <content.json> <output.html> [template.html]
//
// The content JSON carries ONLY real CV content (no invented skills); per-job
// tailoring is just reordering/emphasis. Empty sections (e.g. certifications)
// are removed automatically.
//
// Default template is the H format (templates/cv-template-h.html) — the plain
// human-made look Nikhil requires for every resume that leaves the machine.
// Pass a third arg to use a different template.

import { readFileSync, writeFileSync } from "node:fs";

const [, , contentPath, outPath, tplPath] = process.argv;
if (!contentPath || !outPath) {
  console.error("Usage: node build-resume.mjs <content.json> <output.html> [template.html]");
  process.exit(1);
}

const c = JSON.parse(readFileSync(contentPath, "utf8"));
let tpl = readFileSync(tplPath || "templates/cv-template-h.html", "utf8");

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
      <span class="project-title">${p.url ? `<a href="${p.url}" style="color: inherit; text-decoration: none;">${esc(p.title)}</a>` : esc(p.title)}</span>${p.badge ? `<span class="project-badge">${p.url ? `<a href="${p.url}" style="color: inherit; text-decoration: none;">${esc(p.badge)}</a>` : esc(p.badge)}</span>` : ""}
      ${p.bullets ? `<ul>
        ${p.bullets.map((b) => `<li>${rich(b)}</li>`).join("\n        ")}
      </ul>` : `<div class="project-desc">${rich(p.desc)}</div>`}${p.tech ? `\n      <div class="project-tech">${esc(p.tech)}</div>` : ""}
    </div>`,
  )
  .join("\n");

const education = (c.education || [])
  .map(
    (e) => `    <div class="edu-item">
      <div class="edu-header">
        <span class="edu-title">${esc(e.title)}</span>
        <span class="edu-year">${esc(e.year)}</span>
      </div>
      <span class="edu-org">${esc(e.org)}</span>${e.desc ? `\n      <div class="edu-desc">${esc(e.desc)}</div>` : ""}
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

// Single-line contact header under the name: phone | email | location | links.
// Built here (not in the template) so optional entries (e.g. medium) don't
// leave dangling separators.
const contactLine = [
  c.phone && `<a href="tel:${esc(String(c.phone).replace(/[^+\d]/g, ""))}">${esc(c.phone_display || c.phone)}</a>`,
  c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email_display || c.email)}</a>`,
  c.linkedin_display && `<a class="contact-link" href="${c.linkedin_url || "#"}">${esc(c.linkedin_display)}</a>`,
  c.github_display && `<a class="contact-link" href="${c.github_url || "#"}">${esc(c.github_display)}</a>`,
  c.medium_display && `<a class="contact-link" href="${c.medium_url || "#"}">${esc(c.medium_display)}</a>`,
  c.portfolio_display && `<a class="contact-link" href="${c.portfolio_url || "#"}">${esc(c.portfolio_display)}</a>`,
  c.location && `<span>${esc(c.location)}</span>`,
]
  .filter(Boolean)
  .join(`<span class="separator">|</span>`);

const map = {
  LANG: c.lang || "en",
  CONTACT_LINE: contactLine,
  PAGE_WIDTH: c.page_width || "210mm",
  NAME: esc(c.name),
  TITLE: esc(c.title || ""),
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

// Drop the header title line when the content has no title.
tpl = tpl.replace(/\s*<div class="header-title"><\/div>/, "");

// Drop sections whose content is empty (e.g. certifications, projects).
tpl = tpl.replace(
  /\s*<!-- [A-Z ]+ -->\s*<div class="section[^"]*">\s*<div class="section-title">[^<]*<\/div>\s*(?:<div class="competencies-grid">\s*<\/div>\s*)?<\/div>/g,
  "",
);

writeFileSync(outPath, tpl);
console.log(`✅ ${outPath}`);
