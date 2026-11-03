#!/usr/bin/env node
// Apple India careers sweep. jobs.apple.com search pages embed the full job list
// as escaped JSON; the per-req JD comes back clean from /api/v1/jobDetails/<jobNumber>.
// Both are plain curl-readable (no CSRF), unlike /api/v1/search which returns 0 rows.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36';
const QUERIES = ['devops', 'site reliability', 'platform engineer', 'cloud infrastructure', 'kubernetes', 'build engineer'];

async function get(url, accept = 'text/html') {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, Referer: 'https://jobs.apple.com/en-in/search' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

// The listing JSON is embedded twice-escaped inside the SSR payload; pull the fields
// we need per req with one regex pass rather than trying to unescape the whole blob.
function parseListing(html) {
  const out = new Map();
  const re = /\\"id\\":\\"(\d+-\d+)\\".*?\\"postingTitle\\":\\"(.*?)\\"/g;
  for (const m of html.matchAll(re)) out.set(m[1], m[2]);
  // Fall back to the rendered anchors, which also carry the team slug.
  for (const m of html.matchAll(/href="\/en-in\/details\/(\d+-\d+)\/([a-z0-9-]+)\?team=([A-Z]+)"/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2].replace(/-/g, ' '));
  }
  return out;
}

async function detail(jobNumber) {
  const t = await get(`https://jobs.apple.com/api/v1/jobDetails/${jobNumber}?locale=en-in`, 'application/json');
  return JSON.parse(t).res;
}

const seen = new Map();
for (const q of QUERIES) {
  for (let page = 1; page <= 3; page++) {
    let html;
    try {
      html = await get(`https://jobs.apple.com/en-in/search?search=${encodeURIComponent(q)}&location=india-INDC&page=${page}`);
    } catch (e) { console.error(`  ! ${q} p${page}: ${e.message}`); break; }
    const ids = parseListing(html);
    if (!ids.size) break;
    for (const [id, title] of ids) if (!seen.has(id)) seen.set(id, { id, title, query: q });
    process.stderr.write(`  ${q} p${page}: ${ids.size} ids\n`);
    if (ids.size < 20) break;
  }
}

const jobs = [];
for (const { id, query } of seen.values()) {
  let r;
  try { r = await detail(id); } catch (e) { console.error(`  ! detail ${id}: ${e.message}`); continue; }
  const locs = (r.locations || []).map((l) => l.name).filter(Boolean);
  if (!locs.length) continue;
  const jd = ['description', 'responsibilities', 'minimumQualifications', 'keyQualifications', 'preferredQualifications', 'educationAndExperience']
    .map((k) => r[k]).filter(Boolean).join('\n\n');
  jobs.push({
    id: `apple-${r.jobNumber}`,
    title: r.postingTitle,
    company: 'Apple',
    location: locs.join(', '),
    url: `https://jobs.apple.com/en-in/details/${r.jobNumber}/${r.transformedPostingTitle}`,
    source: 'Apple',
    discovered_via: 'apple',
    posted: r.postingDate || null,
    jd,
    matched_query: query,
  });
}

console.log(JSON.stringify({ scanned_at: new Date().toISOString(), jobs }, null, 1));
console.error(`\n${jobs.length} Apple India reqs with JD text`);
