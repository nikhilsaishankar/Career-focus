// Bulk ATS slug probe: greenhouse + lever + ashby + smartrecruiters.
// Prints India-located infra/devops hits. Read-only; no writes.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36";
const INFRA = /devops|dev ops|sre|site reliability|platform engineer|cloud engineer|infrastructure engineer|cloud ops|cloudops|reliability engineer|build (and|&) release|systems engineer/i;
const INDIA = /india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|gurugram|gurgaon|noida|delhi|ahmedabad|kolkata|coimbatore|remote/i;

const get = async (url, opts = {}) => {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  try { const r = await fetch(url, { headers: { "user-agent": UA, ...(opts.headers || {}) }, signal: ac.signal, ...opts });
    return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
};

async function greenhouse(s) {
  const j = await get(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`);
  return (j?.jobs || []).map(x => ({ ats: "gh", slug: s, id: x.id, title: x.title, loc: x.location?.name || "", url: x.absolute_url }));
}
async function lever(s) {
  const j = await get(`https://api.lever.co/v0/postings/${s}?mode=json`);
  return (Array.isArray(j) ? j : []).map(x => ({ ats: "lever", slug: s, id: x.id, title: x.text, loc: x.categories?.location || "", url: x.hostedUrl }));
}
async function ashby(s) {
  const q = `query A($o:String!){jobBoard:jobBoardWithTeams(organizationHostedJobsPageName:$o){jobPostings{id title locationName}}}`;
  const j = await get(`https://jobs.ashbyhq.com/api/non-user-graphql?op=A`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ operationName: "A", variables: { o: s }, query: q }) });
  return (j?.data?.jobBoard?.jobPostings || []).map(x => ({ ats: "ashby", slug: s, id: x.id, title: x.title, loc: x.locationName || "", url: `https://jobs.ashbyhq.com/${s}/${x.id}` }));
}
async function smartr(s) {
  const j = await get(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`);
  if (!j?.totalFound) return [];
  return (j.content || []).map(x => ({ ats: "sr", slug: s, id: x.id, title: x.name,
    loc: [x.location?.city, x.location?.country].filter(Boolean).join(", "), url: `https://jobs.smartrecruiters.com/${s}/${x.id}` }));
}

const slugs = process.argv.slice(2);
const out = [];
for (let i = 0; i < slugs.length; i += 8) {
  const batch = slugs.slice(i, i + 8);
  const res = await Promise.all(batch.flatMap(s => [greenhouse(s), lever(s), ashby(s), smartr(s)]));
  for (const rows of res) for (const r of rows)
    if (INFRA.test(r.title) && INDIA.test(r.loc)) out.push(r);
}
for (const r of out) console.log(`${r.ats}\t${r.slug}\t${r.id}\t${r.title}\t${r.loc}\t${r.url}`);
console.error(`-- ${out.length} India infra hits over ${slugs.length} slugs`);
