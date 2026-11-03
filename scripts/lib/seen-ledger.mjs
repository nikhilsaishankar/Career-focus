// seen-ledger.mjs — "last 24h / new-today" filter + cross-day dedup ledger.
//
// The daily sheet must show ONLY jobs first seen today, so a job you reviewed (and
// likely applied to) yesterday never reappears tomorrow and pile up as duplicates.
//
// First-seen dates come from each scanner's own data/<portal>-scan-history.tsv
// (format: id \t YYYY-MM-DD \t company \t title [\t source]). Every scanner already
// stamps a job with the date it first discovered it, so that file IS the dedup record.
// Portals that keep no history file (e.g. Foundit) fall back to a single shared dedup
// folder — data/.seen/first-seen.tsv — that this module stamps on first sighting.
//
// A job is "fresh today" iff its resolved first-seen date === today. Re-running the
// build on the same day still shows today's jobs; the next day they age out automatically.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";

const SEEN_DIR = "data/.seen";
const LEDGER = `${SEEN_DIR}/first-seen.tsv`;

// Local-date YYYY-MM-DD (matches the dates the scanners write into the history TSVs).
export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const nameKey = (company, title) => `${norm(company)}|${norm(title)}`;
export const jobKey = (j) => String(j.id ?? j.jobId ?? nameKey(j.company, j.title || j.role));

// Build {byId, byName} → earliest first-seen date, from every data/*-scan-history.tsv.
function loadHistory() {
  const byId = new Map(), byName = new Map();
  if (!existsSync("data")) return { byId, byName };
  for (const f of readdirSync("data").filter((x) => /-scan-history\.tsv$/.test(x))) {
    let txt; try { txt = readFileSync(`data/${f}`, "utf8"); } catch { continue; }
    for (const line of txt.split("\n")) {
      if (!line.trim()) continue;
      const [id, date, company, title] = line.split("\t");
      if (!id || !date) continue;
      const earlier = (m, k) => { const p = m.get(k); if (!p || date < p) m.set(k, date); };
      earlier(byId, String(id));
      if (company || title) earlier(byName, nameKey(company, title));
    }
  }
  return { byId, byName };
}

function loadLedger() {
  const m = new Map();
  if (existsSync(LEDGER)) {
    for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const [key, date] = line.split("\t");
      if (key && date) m.set(key, date);
    }
  }
  return m;
}

// Returns a filter with:
//   .firstSeen(job)    → the job's first-seen date (stamps unknown jobs as today)
//   .isFreshToday(job) → true iff first seen today (the sheet keeps only these)
//   .commit()          → persist any newly-stamped fallback-ledger entries
export function makeFreshFilter(today = todayStr()) {
  const { byId, byName } = loadHistory();
  const ledger = loadLedger();
  let dirty = false;

  const firstSeen = (j) => {
    const id = String(j.id ?? j.jobId ?? "");
    if (id && byId.has(id)) return byId.get(id);
    const nk = nameKey(j.company, j.title || j.role);
    if (byName.has(nk)) return byName.get(nk);
    const k = jobKey(j);
    // Check BOTH the id-key and the company|title key: portals re-post the same
    // opening under a fresh job id, and the name key is what catches the repeat.
    const known = ledger.get(k) ?? ledger.get(nk);
    if (known !== undefined) return known;
    ledger.set(k, today);
    if (nk !== k) ledger.set(nk, today);  // stamp the name too, so a re-id'd repost stays seen
    dirty = true;                          // first sighting ever → it's new today
    return today;
  };

  return {
    firstSeen,
    isFreshToday: (j) => firstSeen(j) === today,
    commit() {
      if (!dirty) return;
      mkdirSync(SEEN_DIR, { recursive: true });
      const out = [...ledger.entries()].map(([k, d]) => `${k}\t${d}`).join("\n") + "\n";
      writeFileSync(LEDGER, out);
    },
  };
}
