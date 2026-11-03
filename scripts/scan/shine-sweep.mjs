// Shine.com DevOps sweep: listing pages -> job slugs -> ld+json JD
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const get = (u) => {
  try { return execFileSync('curl', ['-s', '--max-time', '30', '-H', `User-Agent: ${UA}`, u], { maxBuffer: 1 << 26 }).toString(); }
  catch { return ''; }
};

const queries = process.argv.slice(2);
const slugs = new Set();
for (const q of queries) {
  for (let p = 1; p <= 4; p++) {
    const url = p === 1 ? `https://www.shine.com/job-search/${q}` : `https://www.shine.com/job-search/${q}-${p}`;
    const html = get(url);
    const found = [...html.matchAll(/href="(\/jobs\/[^"?]+)[?"]/g)].map(m => m[1]);
    found.forEach(s => slugs.add(s));
    if (!found.length) break;
  }
}
console.log('slugs:', slugs.size);

const out = [];
for (const s of slugs) {
  const html = get('https://www.shine.com' + s);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const b of blocks) {
    let j; try { j = JSON.parse(b[1]); } catch { continue; }
    if (j['@type'] !== 'JobPosting') continue;
    out.push({
      slug: s,
      id: (s.match(/(\d+)$/) || [])[1],
      title: j.title,
      company: j.hiringOrganization?.name,
      location: [].concat(j.jobLocation || []).map(l => l.address?.addressLocality).filter(Boolean).join(', '),
      datePosted: j.datePosted, validThrough: j.validThrough,
      expMonths: j.experienceRequirements?.monthsOfExperience ?? null,
      desc: (j.description || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  }
}
fs.writeFileSync('/tmp/shine-harvest.json', JSON.stringify(out, null, 1));
console.log('jobs:', out.length);
