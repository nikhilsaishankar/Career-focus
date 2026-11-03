#!/usr/bin/env node
// ats-check.mjs — objective ATS keyword-coverage gate.
//
// Compares a tailored résumé against a job's JD and returns a pass/fail score
// based on how many of the JD's required skills/keywords appear in the résumé.
// It does NOT invent anything — it only measures coverage of what's already there.
//
// Usage:
//   node ats-check.mjs <resume.(json|html|txt)> <jd.txt> ["Job Title"]
//
// Exit code 0 = PASS (>= threshold), 1 = REVIEW (below threshold).

import { readFileSync } from "node:fs";

const PASS_THRESHOLD = 75; // % of in-band JD keywords that must appear in résumé

// DevOps/SRE/cloud vocabulary with aliases. Add terms as your search widens.
const VOCAB = [
  ["ci/cd", ["ci/cd", "ci cd", "cicd", "continuous integration", "continuous deployment", "continuous delivery"]],
  ["jenkins", ["jenkins", "jenkinsfile", "declarative pipeline"]],
  ["docker", ["docker", "dockerfile", "containeris", "containeriz", "container"]],
  ["docker compose", ["docker compose", "docker-compose"]],
  ["kubernetes", ["kubernetes", "k8s", "aks", "eks", "gke", "pods", "deployments"]],
  ["aws", ["aws", "ec2", "ecr", "ecs", " s3", "amazon web services"]],
  ["iam", ["iam", "user access", "access control", "security group", "rbac"]],
  ["git", ["git", "github", "gitlab", "git flow", "gitflow", "branching", "version control", "scm"]],
  ["linux", ["linux", "unix", "shell"]],
  ["maven", ["maven"]],
  ["sonarqube", ["sonarqube", "sonar", "code quality"]],
  ["pipeline automation", ["pipeline", "automation", "automate", "toolchain"]],
  ["build/test/deploy", ["build", "test", "deploy", "release", "staging"]],
  ["monitoring", ["monitoring", "observability", "logging", "alerting", "prometheus", "grafana"]],
  ["iac", ["infrastructure as code", "iac", "terraform", "ansible", "cloudformation", "bicep", "arm template"]],
  ["azure", ["azure", "azure devops"]],
  ["gcp", ["gcp", "google cloud"]],
  ["scripting", ["python", "powershell", "bash scripting", "shell scripting"]],
  ["troubleshooting", ["troubleshoot", "root cause", "rca", "debug", "incident"]],
  ["devsecops", ["devsecops", "vulnerability", "security scan"]],
  ["github actions", ["github actions"]],
  ["sre", ["sre", "site reliability", "sli", "slo", "error budget"]],
];

function loadText(path) {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    return JSON.stringify(JSON.parse(raw)); // flatten all string content
  }
  if (path.endsWith(".html")) {
    return raw.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  }
  return raw;
}

const [, , resumePath, jdPath, jobTitle] = process.argv;
if (!resumePath || !jdPath) {
  console.error('Usage: node ats-check.mjs <resume.(json|html|txt)> <jd.txt> ["Job Title"]');
  process.exit(2);
}

const resume = loadText(resumePath).toLowerCase();
const jd = readFileSync(jdPath, "utf8").toLowerCase();
const has = (text, aliases) => aliases.some((a) => text.includes(a));

// Which vocab terms does the JD actually ask for?
const required = VOCAB.filter(([, aliases]) => has(jd, aliases));
const matched = required.filter(([, aliases]) => has(resume, aliases));
const missing = required.filter(([, aliases]) => !has(resume, aliases)).map(([k]) => k);

const coverage = required.length ? Math.round((matched.length / required.length) * 100) : 0;

// Structural ATS checks (our template is clean, but verify the essentials).
const structure = {
  has_email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(resume),
  has_phone: /(\+?\d[\d ()-]{7,})/.test(resume),
  has_experience: /experience|engineer/.test(resume),
  title_match: jobTitle ? resume.includes(jobTitle.toLowerCase().split("(")[0].trim().slice(0, 12)) : true,
};
const structOk = Object.values(structure).every(Boolean);

const pass = coverage >= PASS_THRESHOLD && structOk;

console.log(`\n=== ATS Check ===`);
console.log(`JD keywords required : ${required.length}`);
console.log(`Matched in résumé    : ${matched.length}`);
console.log(`Coverage             : ${coverage}%  (threshold ${PASS_THRESHOLD}%)`);
console.log(`Structure OK         : ${structOk}  ${JSON.stringify(structure)}`);
if (missing.length) console.log(`Missing (in JD, not résumé): ${missing.join(", ")}`);
console.log(`\nRESULT: ${pass ? "✅ PASS — green signal" : "⚠️  REVIEW — below threshold"}\n`);

process.exit(pass ? 0 : 1);
