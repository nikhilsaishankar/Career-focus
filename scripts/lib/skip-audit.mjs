// skip-audit.mjs — durable record of every job a scanner declined to keep.
//
// A strict 24h/exp filter necessarily drops jobs. The rule here is that it may never
// drop them SILENTLY: each skip lands in data/skip-audit.tsv with the reason, so a run
// can be audited after the fact ("what did the filter throw away today, and why?").
//
// Columns: date \t portal \t reason \t id \t company \t title \t posted \t url

import { appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";

const AUDIT = "data/skip-audit.tsv";
const HEADER = "date\tportal\treason\tid\tcompany\ttitle\tposted\turl\n";

const clean = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ").trim();

export function makeSkipAudit(portal, date = new Date().toISOString().slice(0, 10)) {
  const rows = [];
  return {
    // reason is a stable slug (e.g. "older-than-24h") so the file stays greppable.
    record(reason, job = {}) {
      rows.push(
        [date, portal, clean(reason), clean(job.id), clean(job.company), clean(job.title), clean(job.posted), clean(job.url)].join("\t"),
      );
    },
    get count() {
      return rows.length;
    },
    // Tally by reason, for the run summary.
    byReason() {
      const t = {};
      for (const r of rows) {
        const reason = r.split("\t")[2];
        t[reason] = (t[reason] || 0) + 1;
      }
      return t;
    },
    flush() {
      if (!rows.length) return;
      mkdirSync("data", { recursive: true });
      if (!existsSync(AUDIT)) writeFileSync(AUDIT, HEADER);
      appendFileSync(AUDIT, rows.join("\n") + "\n");
    },
  };
}
