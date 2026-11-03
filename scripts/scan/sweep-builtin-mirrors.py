import re,json,subprocess,sys,os
HOSTS={"builtinhyderabad.in":("builtinhyd","Built In Hyderabad"),
       "builtinbengaluru.in":("builtinblr","Built In Bengaluru"),
       "builtinchennai.in":("builtinchn","Built In Chennai"),
       "builtinpune.in":("builtinpune","Built In Pune")}
def get(url):
    return subprocess.run(["curl","-sL","-A","Mozilla/5.0","-m","35",url],
                          capture_output=True,text=True).stdout
def itemlist(h):
    out=[]
    for blob in re.findall(r'<script type="application/ld(?:\+|&#x2B;)json">(.*?)</script>',h,re.S):
        try: d=json.loads(blob)
        except Exception: continue
        for node in d.get("@graph",[]) if isinstance(d,dict) else []:
            if node.get("@type")=="ItemList":
                for it in node.get("itemListElement",[]):
                    u=it.get("url","")
                    m=re.search(r'/job/[a-z0-9\-]+/(\d+)',u)
                    if m: out.append({"id":m.group(1),"title":it.get("name",""),
                                      "url":u,"blurb":it.get("description","")})
    return out
res={}
for host,(pref,label) in HOSTS.items():
    seen={}
    for p in range(0,11):
        url=f"https://{host}/jobs/dev-engineering/search/devops"+(f"?page={p}" if p>1 else "")
        if p==1: continue
        for r in itemlist(get(url)):
            seen.setdefault(r["id"],dict(r,host=host,prefix=pref,source=label))
    res[host]=list(seen.values())
    print(f"{host}: {len(seen)} uniq",file=sys.stderr)
json.dump(res,open("/tmp/bi/mirror-listings.json","w"),indent=1)
