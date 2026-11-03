#!/usr/bin/env python3
"""Turn Weekday detail records into websearch-scan.json rows.

Usage: python3 -I scripts/scan/weekday-ingest.py <detail.json> <scan.json> <history.tsv> <today>
Fetches the employer ATS link for real JD text + liveness, falls back to Weekday's
aboutRole/skills (marked estimated). Never overwrites an existing id.
"""
import json, re, sys, html, urllib.request, urllib.error, concurrent.futures

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")
PORTAL = re.compile(r'linkedin\.com|weekday\.works|indeed\.|naukri\.|glassdoor\.', re.I)
DEAD = re.compile(r'no longer accepting|position (has been )?(closed|filled)|'
                  r'job (is )?no longer (available|open)|requisition .{0,20}closed|'
                  r'this job posting is no longer', re.I)


def board(url):
    h = re.sub(r'^https?://(?:www\.)?([^/]+).*', r'\1', url or '')
    known = {'jobs.lever.co': 'Lever', 'boards.greenhouse.io': 'Greenhouse',
             'job-boards.greenhouse.io': 'Greenhouse', 'jobs.ashbyhq.com': 'Ashby',
             'linkedin.com': 'LinkedIn', 'www.linkedin.com': 'LinkedIn',
             'jobs.weekday.works': 'Weekday'}
    if h in known:
        return known[h]
    if 'myworkdayjobs.com' in h:
        return 'Workday'
    if 'oraclecloud.com' in h:
        return 'Oracle Cloud'
    return h


def text_of(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                   "Accept": "text/html,application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", "replace")
            code = r.status
    except urllib.error.HTTPError as e:
        return None, e.code
    except Exception:
        return None, 0
    # Lever postings carry JSON-LD; everything else: strip tags
    body = re.sub(r'(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>', ' ', raw)
    body = re.sub(r'(?s)<[^>]+>', ' ', body)
    body = html.unescape(re.sub(r'[ \t\xa0]+', ' ', body))
    body = re.sub(r'\n\s*\n+', '\n', body).strip()
    return body, code


def one(rec):
    if 'dead' in rec:
        return None
    careers = rec.get('careers') or ''
    jd, est, url, live = rec.get('about') or '', True, rec['weekday_url'], None
    if careers and not PORTAL.search(careers):
        body, code = text_of(careers)
        if body and code == 200 and len(body) > 600 and not DEAD.search(body[:6000]):
            jd, est, url, live = body[:20000], False, careers, True
        elif body and code == 200 and not DEAD.search(body[:6000]):
            url, live = careers, True   # SPA shell: live page, thin text
        else:
            live = False
    skills = ', '.join(rec.get('skills') or [])
    jd_full = f"{rec['title']} at {rec['company']}\nLocation: {rec['location']}\n" \
              f"Minimum experience: {rec.get('min_exp')}\nSkills: {skills}\n\n{jd}"
    return {
        "id": "weekday-" + rec['id'],
        "title": rec['title'],
        "company": rec['company'],
        "location": rec['location'],
        "url": url,
        "source": board(url),
        "discovered_via": "weekday",
        "posted": rec['posted'],
        "exp": (f"{rec['min_exp']}+ yrs (≤4 ok)" if rec.get('min_exp') is not None
                else "not stated"),
        "skills": rec.get('skills') or [],
        "jd": jd_full,
        "jd_estimated": est,
        "employer_link_live": live,
        "careers_candidate": careers or None,
    }


recs = json.load(open(sys.argv[1]))
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
    rows = [r for r in ex.map(one, recs) if r]

scan = json.load(open(sys.argv[2]))
have = {j['id'] for j in scan['jobs']}
added = [r for r in rows if r['id'] not in have]
scan['jobs'].extend(added)
scan['scanned_at'] = sys.argv[4] + "T00:00:00.000Z" if len(sys.argv[4]) == 10 else scan.get('scanned_at')
json.dump(scan, open(sys.argv[2], 'w'), indent=1, ensure_ascii=False)

with open(sys.argv[3], 'a', encoding='utf-8') as fh:
    for r in added:
        fh.write(f"{r['id']}\t{sys.argv[4]}\t{r['company']}\t{r['title']}\n")

print(f"added={len(added)} skipped_existing={len(rows)-len(added)}")
for r in added:
    print(f"  {r['id'][:44]:44s} live={r['employer_link_live']} est_jd={r['jd_estimated']} "
          f"src={r['source'][:22]:22s} jdlen={len(r['jd'])}")
