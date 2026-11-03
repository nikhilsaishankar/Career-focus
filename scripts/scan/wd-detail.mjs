import fs from 'node:fs';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ids=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const out=[];
for(const j of ids){
  try{
    const r=await fetch(j.url,{headers:{'User-Agent':UA}});
    if(!r.ok){out.push({...j,_http:r.status});console.error(j.id+' HTTP '+r.status);continue;}
    const h=await r.text();
    const m=h.match(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/);
    let jd='',min=null,careers=null,live=null;
    if(m){
      const pp=JSON.parse(m[1]).props.pageProps||{};
      const job=pp.job||pp.jobData||{};
      jd=job.description||job.jobDescription||job.descriptionMarkdown||'';
      min=job.minimumExperience??job.experienceMin??null;
      careers=job.careersPageLink||job.applyUrl||job.companyCareersPage||null;
      live=job.isActive??job.active??null;
    }
    if(!jd){ jd=h.replace(/<(script|style)[\s\S]*?<\/\1>/g,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' '); }
    out.push({...j,_jd:jd,_min:min,_careers:careers,_live:live});
    console.error(`${j.id} jd=${jd.length} min=${min} careers=${careers?'Y':'-'}`);
  }catch(e){console.error(j.id+' ERR '+e.message);out.push({...j,_err:e.message});}
  await new Promise(r=>setTimeout(r,350));
}
fs.writeFileSync('/tmp/wd_detail.json',JSON.stringify(out,null,1));
