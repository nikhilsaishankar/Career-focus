#!/usr/bin/env python3
"""Fetch Weekday job-detail pages for candidate ids and emit resolved records.

Usage: python3 -I scripts/scan/weekday-detail.py <candidates.json> <out.json> [max]
Each record carries the employer's own careersPageLink (Lever/Greenhouse/Workday/...),
minimumExperience, skills and aboutRole -- enough for ATS scoring + link resolution.
"""
import json, re, sys, urllib.request, concurrent.futures

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def detail(job):
    try:
        html = get(job["url"])
        m = re.search(r'id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
        pp = json.loads(m.group(1))["props"]["pageProps"]
        if pp.get("expired") or not pp.get("activeJob"):
            return {"id": job["id"], "dead": "expired on weekday"}
        d = pp["jobDetails"]
        if not d.get("isAcceptingApplications"):
            return {"id": job["id"], "dead": "not accepting applications"}
        return {
            "id": job["id"],
            "title": d.get("jobTitle") or job["title"],
            "company": d.get("companyName") or job["company"],
            "location": ", ".join(d.get("locationList") or []) or job["location"],
            "careers": d.get("careersPageLink") or d.get("directJobLink"),
            "weekday_url": job["url"],
            "min_exp": d.get("minimumExperience"),
            "employment": d.get("employmentType"),
            "skills": d.get("skills") or job.get("skills") or [],
            "must": d.get("mustHaveSkills") or [],
            "about": d.get("aboutRole") or "",
            "posted": (job.get("postedAt") or "")[:10],
        }
    except Exception as e:
        return {"id": job["id"], "dead": f"fetch failed: {type(e).__name__}"}


cands = json.load(open(sys.argv[1]))
limit = int(sys.argv[3]) if len(sys.argv) > 3 else len(cands)
cands = cands[:limit]
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
    out = list(ex.map(detail, cands))
json.dump(out, open(sys.argv[2], "w"), indent=1)
live = [o for o in out if "dead" not in o]
print(f"fetched={len(out)} live={len(live)} dead={len(out)-len(live)}")
for o in out:
    if "dead" in o:
        print("  DEAD", o["id"], "-", o["dead"])
