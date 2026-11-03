const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const WD=[ // [label, host, site, searchText]
 ['Nasdaq','nasdaq.wd1.myworkdayjobs.com','nasdaq_careers','DevOps Engineer'],
 ['Nasdaq2','nasdaq.wd1.myworkdayjobs.com','Nasdaq_External_Career_Site','DevOps Engineer'],
 ['Bridgestone','bridgestoneamericas.wd1.myworkdayjobs.com','bridgestone','DevOps Engineer'],
 ['NICE','nice.wd3.myworkdayjobs.com','NICE','DevOps Engineer Actimize'],
 ['GBT','amexglobalbusinesstravel.wd3.myworkdayjobs.com','GBTCareers','DevOps Engineer'],
 ['IQEQ','iqeq.wd3.myworkdayjobs.com','IQEQ','DevOps Engineer'],
];
for(const [lab,host,site,q] of WD){
  const url=`https://${host}/wday/cxs/${host.split('.')[0]}/${site}/jobs`;
  try{
    const r=await fetch(url,{method:'POST',headers:{'User-Agent':UA,'Content-Type':'application/json'},body:JSON.stringify({appliedFacets:{},limit:20,offset:0,searchText:q})});
    if(!r.ok){console.log(`${lab}: HTTP ${r.status}`);continue;}
    const d=await r.json();
    console.log(`${lab}: total=${d.total}`);
    for(const p of (d.jobPostings||[]).slice(0,8)) console.log(`   ${p.postedOn} | ${p.locationsText} | ${p.title} | https://${host}/${site}${p.externalPath}`);
  }catch(e){console.log(`${lab}: ERR ${e.message}`);}
}
const SIMPLE=[
 ['Hiver','https://hiverhq.com/careers'],['HiverLever','https://api.lever.co/v0/postings/hiver?mode=json'],
 ['Credgenics','https://credgenics.com/careers'],['CredGH','https://boards-api.greenhouse.io/v1/boards/credgenics/jobs'],
 ['Netcore','https://netcorecloud.com/careers/'],
 ['Basepair','https://www.basepairtech.com/careers'],
 ['Securonix','https://www.securonix.com/careers/'],['SecGH','https://boards-api.greenhouse.io/v1/boards/securonix/jobs'],
 ['Innovature','https://innovature.ai/careers/'],
 ['Helpshift','https://api.lever.co/v0/postings/helpshift?mode=json'],
 ['Material','https://www.materialplus.io/careers'],
 ['Emkay','https://www.emkayglobal.com/careers'],
 ['Neo','https://www.askneo.in/careers'],
 ['EazyERP','https://eazyerp.com/careers/'],
 ['Skandha','https://skandhamedia.com/careers'],
 ['Vodafone','https://opportunities.vodafone.com/search/?q=devops&locationsearch=India'],
];
for(const [lab,u] of SIMPLE){
  try{ const r=await fetch(u,{headers:{'User-Agent':UA},redirect:'follow'});
    const t=await r.text();
    console.log(`${lab}: HTTP ${r.status} bytes=${t.length} devops=${/devops/i.test(t)}`);
  }catch(e){console.log(`${lab}: ERR ${e.message}`);}
}
