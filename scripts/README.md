# scripts/ — the automation, grouped by job

Every script is run with the working directory = **repo root** (the `.sh` orchestrators and
the launchd jobs all `cd` there first). Paths inside scripts resolve from the repo root, and
`scripts/lib/*` anchors itself via `../..`, so the repo works wherever it is cloned.

| Folder | Purpose |
|--------|---------|
| `lib/` | Shared helpers: the fit gate (`job-filters`), `check-gate`, `identity`, `reports-paths`, `seen-ledger`, `skip-audit`, `funnel-to-xlsx` |
| `scan/` | Portal scanners, company-careers sweeps, ATS probes, and scan post-processing |
| `apply/` | Apply assistants + result write-back (`set-job-result`) |
| `resume/` | Résumé build / tailor / ATS check / cover letter |
| `sheets/` | Excel outputs — the Hyderabad sheet and the application tracker |
| `naukri/` | Naukri profile freshness + keyword helpers |
| `pipelines/` | The `.sh` orchestrators and launchd entrypoints |

Nothing here hardcodes personal data: name, email, phone and résumé paths come from
`config/profile.json` via `lib/identity.mjs`, and portal logins come from
`~/.career-ops/credentials.json` — outside the repo.
