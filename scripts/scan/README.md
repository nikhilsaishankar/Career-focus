# scripts/scan/ — scanners, sweeps, post-processing

**Board scanners** write `data/<portal>-scan.json` (+ `.md`/`.log`). The active six:

| Script | Board | Needs |
|--------|-------|-------|
| `scan-devops.mjs` | LinkedIn (last 24h) | nothing |
| `scan-naukri.mjs` | Naukri | saved session |
| `scan-google.mjs` | Google jobs tab | nothing |
| `scan-indeed.mjs` | Indeed India | real Chrome (Cloudflare) |
| `scan-hirist.mjs` | Hirist | saved session |
| `scan-instahyre.mjs` | Instahyre | saved session |

Also present: `scan-cutshort.mjs`, `scan-wellfound.mjs`, `scan-apple.mjs`, `scan-talent.mjs`,
`scan-apna-shine.mjs`.

**Company-careers sweeps** (resolve a portal link to the employer's own live posting):
`sf-sweep.mjs` / `sf-jd.mjs` (Salesforce), `wd-sweep-2145.mjs` / `wd-detail.mjs` (Workday),
`weekday-ingest.py` / `weekday-detail.py`, `sweep-builtin-mirrors.py` / `builtin-mirror-jd.py`,
`shine-sweep.mjs`, `slug-sweep.mjs`, `jobfound-sweep.mjs`, `joindevops-sweep.mjs`.

**Post-processing:**
- `accumulate.mjs` — merges each run into the durable pool, so nothing a scan dropped disappears.
- `process-scans.mjs` — deterministic ATS + fit scoring and write-back.
- `probe-ats.mjs` — identifies which ATS a posting runs on.
- `ingest-jobs.mjs` — pulls hand-collected jobs into the pipeline.
- `scan-stats.mjs` — per-run funnel stats.

Run from the repo root, e.g. `node scripts/scan/scan-devops.mjs 10`. Orchestrated by `../pipelines/`.
