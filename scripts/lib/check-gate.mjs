#!/usr/bin/env node
// check-gate.mjs — authoritative fit-gate check for a single job, callable from the shell.
// Used by the autonomous auto-process.sh agent so it never has to self-judge the gate in
// prose (that's how the ATS-only "pass = true if ATS >= 75" prompt drift happened,
// 2026-07-30 lesson) — it calls this instead and trusts the real sheetAdmits() logic,
// the SAME function the HYDERABAD sheet and /jd use.
//
// Usage:
//   node scripts/lib/check-gate.mjs <scan-file> <job-id>
//   node scripts/lib/check-gate.mjs --json '<job JSON blob>'
//
// Exit code 0 + "PASS" on stdout = clears the gate. Exit code 1 + "REJECT: <reason>" = fails.

import { readFileSync } from "node:fs";
import { sheetAdmits, tooSenior, isAzureJob, isGcpJob, isWrongCore, isWrongPlatformTitle, wrongPlatformMustHave, isSuspectEmployer, isSupportRole, isAppSupportCore, isOutOfBandGrade, bodyExpFloor } from "./job-filters.mjs";

const [, , a, b] = process.argv;

let job;
if (a === "--json") {
  job = JSON.parse(b);
} else {
  const file = a;
  const id = b;
  if (!file || !id) {
    console.error("Usage: node scripts/lib/check-gate.mjs <scan-file> <job-id>  OR  --json '<job JSON>'");
    process.exit(2);
  }
  const path = file.includes("/") ? file : `data/${file}`;
  const data = JSON.parse(readFileSync(path, "utf8"));
  job = (data.jobs || []).find((j) => String(j.id) === String(id));
  if (!job) {
    console.error(`REJECT: no job with id=${id} found in ${path}`);
    process.exit(1);
  }
}

if (sheetAdmits(job)) {
  console.log("PASS");
  process.exit(0);
} else {
  const reasons = [];
  if (tooSenior(job)) {
    const body = bodyExpFloor(job.jd);
    reasons.push(
      body !== null
        ? `experience floor > 4 years (JD body states ${body}+ yrs${job.exp ? `, portal header said "${job.exp}"` : ""})`
        : "experience floor > 4 years",
    );
  }
  if (isAzureJob(job)) reasons.push("Azure-only stack (no AWS)");
  if (isGcpJob(job)) reasons.push("GCP-only stack (no AWS)");
  if (isWrongCore(job)) reasons.push("wrong-core stack (VMware/mainframe/Go Lang/etc. as a real must-have)");
  if (isWrongPlatformTitle(job)) reasons.push("wrong-platform seat named in the title (Salesforce/Copado/ServiceNow/SAP/MuleSoft/Pega/Power Platform, or an EUC/Intune/VDI/Citrix/desktop-packaging/Guidewire seat — zero cv.md coverage)");
  const platMust = wrongPlatformMustHave(job);
  if (platMust) reasons.push(`wrong-platform must-have declared in the JD body ("${platMust}") \u2014 enterprise-platform seat under a generic DevOps title, zero cv.md coverage`);
  if (isSuspectEmployer(job)) reasons.push("suspect employer (training academy/placement institute)");
  if (isSupportRole(job)) reasons.push("support-titled role with none of his core stack");
  if (isAppSupportCore(job)) reasons.push("L2/L3 application-support core in the JD body (escalations/production support duties, no pipeline or platform ownership) under an engineering title");
  if (isOutOfBandGrade(job)) reasons.push("out-of-band grade in title (Director/Head/VP/Principal/Manager-class seat)");
  console.log(`REJECT: ${reasons.join("; ") || "fails fit gate"}`);
  process.exit(1);
}
