#!/usr/bin/env node

// tailor-resume.mjs — produce a per-JD tailored content JSON from the base CV.
//
// Tailoring is REORDER + EMPHASIS ONLY. It never invents skills, bullets, or
// metrics that are not already in the base content (which is kept in sync with
// the canonical Downloads/H résumé / cv.md). The JD only decides ORDER and which
// true keywords get bolded — so every résumé stays factually identical to the
// H PDF while surfacing what each specific JD asks for first.
//
// Usage:
//   node tailor-resume.mjs <jd.txt> [base-content.json] [out-content.json]
// Defaults:
//   base-content.json = output/cv-content.json
//   out-content.json  = output/tailored-content.json
//
// Then: node build-resume.mjs <out-content.json> out.html && node generate-pdf.mjs out.html out.pdf

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const [, , jdPath, baseArg, outArg] = process.argv;
if (!jdPath) {
  console.error("Usage: node tailor-resume.mjs <jd.txt> [base-content.json] [out-content.json]");
  process.exit(2);
}
const basePath = baseArg || join(__dirname, "..", "..", "output", "cv-content.json");
const outPath = outArg || join(__dirname, "..", "..", "output", "tailored-content.json");

if (!existsSync(jdPath)) { console.error(`JD not found: ${jdPath}`); process.exit(2); }
if (!existsSync(basePath)) { console.error(`Base content not found: ${basePath}`); process.exit(2); }

const jd = readFileSync(jdPath, "utf8").toLowerCase();
const cv = JSON.parse(readFileSync(basePath, "utf8"));

// Resume-true tech vocabulary. ONLY terms genuinely on the résumé appear here —
// this is what we are allowed to reorder/emphasize around. Aliases group
// equivalent phrasings so a JD saying "k8s" still matches "kubernetes".
const VOCAB = [
  ["docker compose", ["docker compose", "docker-compose", "compose"]],
  ["ci/cd", ["ci/cd", "cicd", "ci cd", "continuous integration", "continuous delivery", "continuous deployment", "pipeline", "pipelines"]],
  ["jenkins", ["jenkins", "jenkinsfile", "declarative pipeline"]],
  ["docker", ["docker", "dockerfile", "container", "containers", "containerise", "containerize", "containerisation", "containerization"]],
  ["kubernetes", ["kubernetes", "k8s", "kubectl"]],
  ["helm", ["helm"]],
  ["kops", ["kops"]],
  ["statefulsets", ["statefulset", "statefulsets"]],
  ["deployments", ["deployment", "deployments"]],
  ["namespaces", ["namespace", "namespaces"]],
  ["rbac", ["rbac", "role-based access"]],
  ["minikube", ["minikube"]],
  ["node-exporter", ["node-exporter", "node exporter"]],
  ["argocd", ["argocd", "argo cd", "gitops"]],
  ["aws", ["aws", "amazon web services"]],
  ["ec2", ["ec2"]],
  ["ecr", ["ecr"]],
  ["ecs", ["ecs", "fargate"]],
  ["iam", ["iam"]],
  ["prometheus", ["prometheus"]],
  ["grafana", ["grafana"]],
  ["maven", ["maven"]],
  ["sonarqube", ["sonarqube", "sonar"]],
  ["git flow", ["git flow", "gitflow", "branching strategy", "branch protection"]],
  ["github", ["github"]],
  ["gitlab", ["gitlab"]],
  ["git", ["\\bgit\\b", "version control"]],
  ["linux", ["linux", "ubuntu", "unix"]],
  ["bash", ["bash", "shell script", "shell scripting", "scripting"]],
  ["webhook", ["webhook", "webhooks"]],
  ["monitoring", ["monitoring", "observability", "dashboards", "metrics"]],
];

// Curated JD-phrasing synonyms. Each entry: if the JD uses `add`'s wording AND
// the résumé genuinely shows the skill (one of `have` is present) AND that exact
// phrase isn't already on the résumé, we surface the JD's term as a skills
// keyword under `category`. This mirrors the JD's language for a skill you
// REALLY have (truthful, ATS-optimal) — it never adds a skill you lack.
const SYNONYM_INJECT = [
  { have: ["kubernetes", "k8s", "kops", "minikube"], add: "Container Orchestration", category: "Container Orchestration" },
  { have: ["docker", "dockerfile"], add: "Containerization", category: "Containers" },
  { have: ["prometheus", "grafana"], add: "Observability", category: "Packaging & Monitoring" },
  { have: ["jenkins", "ci/cd", "cicd"], add: "Continuous Integration", category: "CI/CD & Automation" },
  { have: ["jenkins", "ci/cd", "cicd"], add: "Continuous Delivery", category: "CI/CD & Automation" },
  { have: ["jenkins", "ci/cd", "cicd"], add: "Build Automation", category: "CI/CD & Automation" },
  { have: ["bash", "shell"], add: "Shell Scripting", category: "Operating Systems & Tools" },
  { have: ["ec2", "ecs", "ecr", "aws", "iam"], add: "Cloud Infrastructure", category: "Cloud Platforms" },
  { have: ["git flow", "gitflow", "branch protection"], add: "Branching Strategy", category: "SCM & Branching" },
  { have: ["argocd", "gitops"], add: "GitOps", category: "CI/CD & Automation" },
];

// Which canonical vocab terms does THIS JD ask for?
const jdHas = (aliases) => aliases.some((a) => new RegExp(a.includes("\\b") ? a : a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(jd));
const jdTerms = new Set(VOCAB.filter(([, al]) => jdHas(al)).map(([k]) => k));

// Score a piece of text by how many JD-requested vocab terms it contains.
function score(text) {
  const t = (text || "").toLowerCase();
  let s = 0;
  for (const [canon, aliases] of VOCAB) {
    if (!jdTerms.has(canon)) continue;
    if (aliases.some((a) => new RegExp(a.includes("\\b") ? a : a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(t))) s++;
  }
  return s;
}

// Stable sort: higher score first, original order preserved on ties.
function reorder(arr, textOf) {
  return arr
    .map((item, i) => ({ item, i, s: score(textOf(item)) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

// H format is plain text only (per Nikhil, no bold anywhere in tailored output)
// — reorder/emphasis means ORDER, never bold markers. Kept as a passthrough so
// callers below don't need to change.
function emphasize(text) {
  return text;
}

// --- Apply tailoring ---------------------------------------------------------
const out = JSON.parse(JSON.stringify(cv)); // deep clone, keep everything

// 1. Core competencies: surface JD-relevant ones first (keep all).
if (Array.isArray(out.competencies)) out.competencies = reorder(out.competencies, (c) => c);

// 2. Skills: reorder categories, and items within each category (keep all).
if (Array.isArray(out.skills)) {
  out.skills = out.skills.map((cat) => ({
    ...cat,
    items: Array.isArray(cat.items) ? reorder(cat.items, (it) => (typeof it === "string" ? it : it.name || "")) : cat.items,
  }));
  out.skills = reorder(out.skills, (cat) => `${cat.category} ${(cat.items || []).map((it) => (typeof it === "string" ? it : it.name)).join(" ")}`);
}

// 3. Experience: keep jobs in chronological order; reorder + emphasize bullets.
if (Array.isArray(out.experience)) {
  out.experience = out.experience.map((job) => ({
    ...job,
    bullets: Array.isArray(job.bullets) ? reorder(job.bullets, (b) => b).map(emphasize) : job.bullets,
  }));
}

// 4. Projects: surface JD-relevant projects first; emphasize their descriptions.
if (Array.isArray(out.projects)) {
  out.projects = reorder(out.projects, (p) => `${p.title} ${p.desc}`).map((p) => ({ ...p, desc: emphasize(p.desc) }));
}

// 5. Summary: emphasis only (never reordered — it's a single paragraph).
if (typeof out.summary === "string") out.summary = emphasize(out.summary);

// 6. JD-phrasing synonyms: mirror the JD's wording for skills you genuinely have.
const haystack = JSON.stringify(out).toLowerCase();
const injected = [];
if (Array.isArray(out.skills)) {
  for (const syn of SYNONYM_INJECT) {
    const jdWantsPhrase = jd.includes(syn.add.toLowerCase());
    const haveSkill = syn.have.some((h) => haystack.includes(h));
    const alreadyOnResume = haystack.includes(syn.add.toLowerCase());
    if (!jdWantsPhrase || !haveSkill || alreadyOnResume) continue;
    const cat = out.skills.find((c) => c.category === syn.category);
    if (!cat || !Array.isArray(cat.items)) continue;
    const exists = cat.items.some((it) => (typeof it === "string" ? it : it.name || "").toLowerCase() === syn.add.toLowerCase());
    if (exists) continue;
    cat.items.unshift(typeof cat.items[0] === "string" || cat.items.length === 0 ? syn.add : { name: syn.add });
    injected.push(syn.add);
  }
}

writeFileSync(outPath, JSON.stringify(out, null, 2));

const matched = [...jdTerms];
console.log(`✅ tailored -> ${outPath}`);
console.log(`   JD keywords matched (${matched.length}): ${matched.join(", ") || "(none — base order kept)"}`);
console.log(`   JD-phrasing added (${injected.length}): ${injected.join(", ") || "(none)"}`);
