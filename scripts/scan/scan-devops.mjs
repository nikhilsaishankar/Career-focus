#!/usr/bin/env node
// scan-devops.mjs — auto-scan LinkedIn for fresh "DevOps Engineer" roles.
//
// Pulls up to 10 jobs (last 24h, Hyderabad), fetches each full JD, and writes
// them to data/devops-scan.json + data/devops-scan.md. Stops after 10 findings.
//
// Naukri auto-scan is NOT possible (recaptcha-walled) — use open-jobs.sh to open
// Naukri in the browser, then paste any good Naukri URLs/JDs into career-ops.
//
// Usage: node scan-devops.mjs [maxJobs]   (default 10)

import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { reportPaths } from "../lib/reports-paths.mjs";
import { makeSkipAudit } from "../lib/skip-audit.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HISTORY = "data/devops-scan-history.tsv"; // jobId \t date \t company \t title — never miss / never repeat
const RP = reportPaths(); // reports_stats/<YYYY-MM-DD>/
const MOD = RP.mod(1, "module01-LinkedIn"); // Tier1/module01-LinkedIn/
const STATUS = MOD.md("module01-LinkedIn.md");
const XLSX_OUT = MOD.xlsx("module01-LinkedIn.xlsx");
const JSON_OUT = MOD.json("module01-LinkedIn.json");

// No cap by default: the 24h window IS the filter, so truncating it would silently
// discard qualifying jobs. Pass a positive integer to cap (0 / absent = unlimited).
const maxArg = parseInt(process.argv[2] || "0", 10);
const MAX = Number.isFinite(maxArg) && maxArg > 0 ? maxArg : Infinity;
// LinkedIn's guest endpoint pages 25 at a time and dries up well before this bound.
const PAGE_HARD_STOP = 1000;
const audit = makeSkipAudit("linkedin");
// Search phrase — override per-run with --kw="..." so the pipeline can sweep the whole
// DevOps family (SRE / Platform / Cloud Engineer), not just the literal phrase.
const kwArg = process.argv.slice(2).find((a) => a.startsWith("--kw="));
const KEYWORDS = kwArg ? kwArg.slice(5) : '"DevOps Engineer"'; // double quotes -> exact phrase
const LOCATION = "Hyderabad, Telangana, India"; // Hyderabad ONLY — per user 2026-07-25 (one goal: Hyderabad)
// DevOps family — search is "DevOps Engineer", and from the results we keep ANY role in the
// DevOps umbrella (DevOps/SRE/Cloud/Platform/Infra/Release) and drop clearly-unrelated ones
// (Recovery Manager / Software Engineer / Data Engineer). Same regex used in scan-naukri.mjs.
const DEVOPS_TITLE =
  /dev[\s-]?ops|\bsre\b|site\s*reliability|platform\s*eng|infrastructure\s*eng|\binfra\s*eng|cloud\s*(eng|ops|infra|architect)|release\s*eng|build\s*(and|&)\s*release/i;
// Experience band filter: keep only roles whose required years overlap [3, 4].
// Drops senior roles (5+, 8-12, 10+) and sub-3 roles. Unknown-exp roles are kept (flagged).
const EXP_MIN = 3;
const EXP_MAX = 4;

// Parse the minimum + maximum required years from JD text.
// Returns { lo, hi } in years, or null if no requirement detected.
function parseExp(text) {
  const t = text.toLowerCase();
  let lo = null,
    hi = null;
  // "3-5 years", "8 to 12 years", "3 - 5 yrs"
  for (const m of t.matchAll(/(\d{1,2})\s*(?:-|to|–)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?|yoe)/g)) {
    const a = +m[1], b = +m[2];
    lo = lo === null ? a : Math.min(lo, a);
    hi = hi === null ? b : Math.max(hi, b);
  }
  // "5+ years", "10+ years", "minimum 6 years"
  for (const m of t.matchAll(/(?:minimum\s+|min\.?\s+|atleast\s+|at least\s+)?(\d{1,2})\s*\+\s*(?:years?|yrs?|yoe)/g)) {
    const a = +m[1];
    lo = lo === null ? a : Math.min(lo, a);
  }
  if (lo === null && hi === null) return null;
  return { lo: lo ?? hi, hi };
}

// Does the role's required range overlap the user's target band [EXP_MIN, EXP_MAX]?
function fitsBand(exp) {
  if (!exp) return { fit: true, reason: "exp not stated (kept)" };
  const lo = exp.lo;
  const hi = exp.hi ?? exp.lo;
  // Rule: required experience must be ≤ 4 yrs. Drop only roles whose FLOOR is 5+;
  // keep ≤4 and lower (we shortlist via the platform exp filter where available).
  if (lo > EXP_MAX) return { fit: false, reason: `requires ${lo}+ yrs (above 4)` };
  return { fit: true, reason: `${exp.lo}${exp.hi ? "-" + exp.hi : "+"} yrs (≤4 ok)` };
}
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, " • ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

function field(block, re) {
  const m = block.match(re);
  return m ? strip(m[1]) : "";
}

// Retry transient failures (network drops, 429, 5xx) instead of losing the page.
// A bare fetch() throw used to abort the whole scan mid-run and still exit 0.
async function get(url, tries = 5) {
  let lastErr = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await sleep(Math.min(2 ** attempt * 1000, 30000));
    let res;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,application/json" },
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      lastErr = e?.cause?.code || e?.name || String(e);
      console.error(`  [retry ${attempt + 1}/${tries}] ${lastErr}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = parseInt(res.headers.get("retry-after") || "0", 10);
      if (wait > 0) await sleep(Math.min(wait * 1000, 60000));
      lastErr = `HTTP ${res.status}`;
      console.error(`  [retry ${attempt + 1}/${tries}] ${lastErr}`);
      continue;
    }
    return { status: res.status, text: await res.text() };
  }
  // Exhausted: surface it as a throw so the caller can fail the run loudly.
  throw new Error(`GET failed after ${tries} tries: ${lastErr} — ${url}`);
}

async function fetchJD(jobId) {
  try {
    const { status, text } = await get(
      `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`,
    );
    if (status !== 200) return "";
    const m = text.match(
      /<div class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    return m ? strip(m[1]) : "";
  } catch {
    return "";
  }
}

function loadHistory() {
  if (!existsSync(HISTORY)) return new Set();
  return new Set(
    readFileSync(HISTORY, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t")[0]),
  );
}

async function scan() {
  const jobs = [];
  const seen = loadHistory(); // skip jobs already seen on previous days
  for (let start = 0; start < PAGE_HARD_STOP && jobs.length < MAX; start += 25) {
    const url =
      `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?` +
      `keywords=${encodeURIComponent(KEYWORDS)}&location=${encodeURIComponent(LOCATION)}` +
      `&f_TPR=r86400&start=${start}`;
    const { status, text } = await get(url);
    if (status === 404) break; // past the last page — normal exhaustion
    if (status !== 200) {
      // Not exhaustion: pages may still hold qualifying jobs. Fail the run rather
      // than reporting a truncated result set as a complete one.
      throw new Error(`LinkedIn page start=${start} returned HTTP ${status}`);
    }
    const cards = text.split('<div class="base-card').slice(1);
    if (cards.length === 0) break;
    for (const card of cards) {
      if (jobs.length >= MAX) break;
      const id = (card.match(/urn:li:jobPosting:(\d+)/) || [])[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const link = (card.match(/href="(https:\/\/[a-z.]*linkedin\.com\/jobs\/view\/[^"]+)"/) || [])[1] || "";
      const title = field(card, /<span class="sr-only">\s*([\s\S]*?)\s*<\/span>/);
      const company = field(card, /base-search-card__subtitle[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
      const location = field(card, /job-search-card__location[^>]*>([\s\S]*?)<\/span>/);
      const posted = (card.match(/datetime="([^"]+)"/) || [])[1] || "";
      // Keep the whole DevOps family (DevOps/SRE/Cloud/Platform/Infra/Release), drop
      // clearly-unrelated roles (Recovery Manager / Software Engineer / Data Engineer) and
      // internships. Same regex as the Naukri scanner — keep them identical.
      if (/\bintern(ship)?\b/i.test(title) || !DEVOPS_TITLE.test(title)) {
        const reason = /\bintern(ship)?\b/i.test(title) ? "internship" : "title-not-devops-family";
        audit.record(reason, { id, company, title, posted, url: link });
        console.error(`  [skip] ${company} — ${title} (${reason})`);
        continue;
      }
      const jd = await fetchJD(id);
      await sleep(400); // be polite, avoid rate limit
      const exp = parseExp(`${title}\n${jd}`);
      const band = fitsBand(exp);
      if (!band.fit) {
        audit.record("exp-out-of-band", { id, company, title, posted, url: link });
        console.error(`  [skip] ${company} — ${title} (${band.reason})`);
        continue; // does NOT count toward the findings
      }
      jobs.push({
        id,
        title,
        company,
        location,
        posted,
        url: link.replace(/\?.*$/, ""),
        apply_url: link,
        exp: band.reason,
        jd,
      });
      console.error(`  [${jobs.length}/${MAX}] ${company} — ${title}  ·  ${band.reason}`);
    }
    await sleep(600);
  }
  return jobs;
}

// A crashed scan must never look like a quiet one. On unrecoverable failure, leave the
// previous scan JSON untouched, stamp a failure marker, and exit non-zero so the
// dispatcher (and the sheet's State column) can tell "blocked" from "no new jobs".
let jobs;
try {
  jobs = await scan();
} catch (err) {
  audit.flush();
  mkdirSync("data", { recursive: true });
  writeFileSync(
    "data/devops-scan.failed.json",
    JSON.stringify({ failed_at: new Date().toISOString(), source: "linkedin", error: String(err.message || err) }, null, 2),
  );
  console.error(`\n❌ LinkedIn scan FAILED — ${err.message || err}`);
  console.error("   Previous data/devops-scan.json left intact. Marker: data/devops-scan.failed.json");
  process.exit(1);
}
const now = new Date().toISOString();

const devopsJson = JSON.stringify({ scanned_at: now, source: "linkedin", tier: 1, module: "module01-LinkedIn", query: KEYWORDS, location: LOCATION, count: jobs.length, jobs }, null, 2);
writeFileSync("data/devops-scan.json", devopsJson); // kept for pipeline compatibility
writeFileSync(JSON_OUT, devopsJson); // lives with md+xlsx in the module folder

let md = `# DevOps Scan — ${now.slice(0, 10)}\n\nQuery: \`"DevOps Engineer"\` · Last 24h · ${LOCATION} · ${jobs.length} jobs\n\n`;
for (const [i, j] of jobs.entries()) {
  md += `## ${i + 1}. ${j.company} — ${j.title}\n`;
  md += `- **Location:** ${j.location}\n- **Experience:** ${j.exp}\n- **Posted:** ${j.posted}\n- **JD link:** ${j.url}\n\n`;
  md += `${j.jd ? j.jd.slice(0, 4000) : "_(JD not retrieved — open the link)_"}\n\n---\n\n`;
}
writeFileSync("data/devops-scan.md", md);

// Record new jobs so future daily runs never repeat them (and never miss new ones).
const date = now.slice(0, 10);
for (const j of jobs) {
  appendFileSync(HISTORY, `${j.id}\t${date}\t${j.company}\t${j.title}\n`);
}

// A previous run may have left a failure marker; this run succeeded, so clear it.
try { if (existsSync("data/devops-scan.failed.json")) rmSync("data/devops-scan.failed.json"); } catch {}

audit.flush();
console.error(`\n✅ ${jobs.length} NEW in-band jobs -> data/devops-scan.json + data/devops-scan.md`);
if (audit.count) {
  const t = Object.entries(audit.byReason()).map(([r, n]) => `${r}=${n}`).join(" · ");
  console.error(`🧾 ${audit.count} skipped (audited -> data/skip-audit.tsv): ${t}`);
}
if (jobs.length === 0) console.error("ℹ️  No new in-band (3-4 yr) DevOps jobs since last scan.");

// Write the daily FUNNEL TABLE. The scan fills the step-1 columns (New + Link); the agent
// fills JD Fit / ATS / Pass / Résumé / Status during "process the scan" (replacing the ⏳).
{
  const d = new Date();
  const hour = d.getHours();
  const slot = hour < 12 ? "🌅" : hour < 19 ? "☀️" : "🌙"; // first half / second half / night
  const dateStr = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  const HEAD =
    "# Module 01 — LinkedIn DevOps Funnel (Tier 1)\n\n" +
    "LinkedIn rows only (Google = module02, Dream = module03). Legend: **New** = filter found it · **JD Fit** ✅/⚠️/❌ · **ATS** = keyword match vs your CV · **Pass** = ATS ≥ 75% · **Status** 🟢 Ready to apply / 🟡 Borderline / 🔴 Skip / ⚪ none. ⏳ = waiting for `process the scan`.\n" +
    "Slots: 🌅 First half (6–11) · ☀️ Second half (2–6) · 🌙 Night (8–11).\n";
  mkdirSync(dirname(STATUS), { recursive: true });
  const COLS =
    "| Slot | Source | Company — Role | Link | New | JD Fit | ATS | Pass | Résumé | Status |\n" +
    "|------|--------|----------------|------|-----|--------|-----|------|--------|--------|\n";
  let content = existsSync(STATUS) ? readFileSync(STATUS, "utf8") : HEAD;
  if (!content.includes(`## ${dateStr}`)) content += `\n## ${dateStr}\n\n${COLS}`;
  if (jobs.length === 0) {
    content += `| ${slot} | LinkedIn | _(no new jobs — scan ran ${time})_ | — | — | — | — | — | — | ⚪ 0 new |\n`;
  } else {
    for (const j of jobs) {
      content += `| ${slot} | LinkedIn | ${j.company} — ${j.title} | [open](${j.url}) | ✅ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ to process |\n`;
    }
  }
  writeFileSync(STATUS, content);
  // Regenerate the Excel view in reports_stats/ (best-effort — never break the scan).
  try {
    execFileSync(process.execPath, [join(SCRIPT_DIR, "..", "lib", "funnel-to-xlsx.mjs"), STATUS, XLSX_OUT], { stdio: "ignore" });
  } catch {}
}

// macOS notification so you never miss a fresh posting.
// Desktop notifications disabled per Nikhil 2026-10-26 ("i should not receive
// notification as well"). The day-wise sheet is the only status surface.
if (false && process.platform === "darwin") {
  const msg =
    jobs.length > 0
      ? `${jobs.length} new DevOps job(s) in your band. Open Claude: "process the scan"`
      : "No new in-band DevOps jobs today.";
  /* notifications disabled — see note above
execFile("osascript", [
    "-e",
    `display notification "${msg.replace(/"/g, "'")}" with title "career-ops · DevOps scan" sound name "Glass"`,
  ]);
*/
}
