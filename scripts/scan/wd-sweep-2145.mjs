import fs from 'node:fs';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const out=[];
for (let p=21;p<=45;p++){
  const url=`https://www.weekday.works/jobs/devops-engineer-jobs-in-india-${p}`;
  try{
    const r=await fetch(url,{headers:{'User-Agent':UA}});
    if(!r.ok){console.error('p'+p+' HTTP '+r.status);continue;}
    const h=await r.text();
    const m=h.match(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/);
    if(!m){console.error('p'+p+' no NEXT_DATA');continue;}
    const jobs=JSON.parse(m[1]).props.pageProps.jobs||[];
    out.push(...jobs);
    console.error(`p${p}: ${jobs.length}`);
  }catch(e){console.error('p'+p+' ERR '+e.message);}
  await new Promise(r=>setTimeout(r,400));
}
const seen=new Set(); const uniq=out.filter(j=>!seen.has(j.id)&&seen.add(j.id));
fs.writeFileSync('/tmp/wd_2145.json',JSON.stringify(uniq,null,1));
console.error(`TOTAL raw=${out.length} uniq=${uniq.length}`);
