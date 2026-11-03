#!/usr/bin/env node
// SuccessFactors board sweep (Deloitte South Asia, EY) — search pages are curl-readable.
// Usage: node scripts/scan/sf-sweep.mjs list   -> prints TSV: board<TAB>id<TAB>title<TAB>location<TAB>url
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const BOARDS = [
  { name: 'Deloitte', base: 'https://southasiacareers.deloitte.com', search: '/search/?q=', jobPrefix: '/job/' },
  { name: 'EY',       base: 'https://careers.ey.com',                search: '/ey/search/?q=', jobPrefix: '/ey/job/' },
];
const KEYWORDS = ['devops', 'site reliability', 'cloud engineer', 'platform engineer', 'kubernetes', 'aws'];

function get(url) {
  try {
    return execFileSync('curl', ['-s', '-m', '30', '-A', UA, url], { maxBuffer: 1 << 26 }).toString();
  } catch { return ''; }
}
const unent = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const out = new Map();
for (const b of BOARDS) {
  for (const kw of KEYWORDS) {
    for (const start of [0, 25]) {
      const url = `${b.base}${b.search}${encodeURIComponent(kw)}&startrow=${start}`;
      const html = get(url);
      if (!html) continue;
      // Each result row: <a href="/job/<slug>/<id>/" ...>Title</a> ... location cell
      const re = new RegExp(`href="(${b.jobPrefix}[^"]+?/(\\d+)/)"[^>]*>([\\s\\S]{0,300}?)</a>`, 'g');
      let m;
      while ((m = re.exec(html))) {
        const [, href, id, inner] = m;
        const title = unent(inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
        if (!title) continue;
        const key = b.name + ':' + id;
        if (out.has(key)) continue;
        // location: the slug's leading city token
        const slug = unent(href);
        const city = (slug.match(new RegExp(`${b.jobPrefix}([A-Za-z]+)-`)) || [, ''])[1];
        out.set(key, { board: b.name, id, title, location: city, url: b.base + slug });
      }
    }
  }
}
for (const j of out.values()) console.log([j.board, j.id, j.title, j.location, j.url].join('\t'));
console.error(`[sf-sweep] ${out.size} unique reqs across ${BOARDS.length} boards`);
