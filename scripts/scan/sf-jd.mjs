#!/usr/bin/env node
// Fetch + clean a SuccessFactors job page into plain JD text.
// Usage: node scripts/scan/sf-jd.mjs <url>
import { execFileSync } from 'node:child_process';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const url = process.argv[2];
let html = '';
try { html = execFileSync('curl', ['-sL', '-m', '35', '-A', UA, url], { maxBuffer: 1 << 26 }).toString(); } catch {}
if (!html) { console.error('FETCH_FAIL'); process.exit(2); }

// Prefer the real JD container; fall back to whole body.
let body = html;
const m = html.match(/<div[^>]*class="[^"]*jobdescription[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
       || html.match(/<span[^>]*id="[^"]*jobdescription[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
if (m) body = m[1];

let txt = body
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n\s*\n\s*\n+/g, '\n\n');

// Cut the site chrome that fakes a 100% ATS match (per known SuccessFactors pitfall).
const cut = txt.search(/Skip to main content/i);
if (cut > -1) txt = txt.slice(cut + 'Skip to main content'.length);
// Drop the trailing nav/footer blocks
txt = txt.split(/Share this Job|Find Similar Jobs|Job Segment|Sign in to your account/i)[0];
console.log(txt.trim());
