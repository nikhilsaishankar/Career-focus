# scripts/lib/ — shared helpers

| File | Role |
|------|------|
| `job-filters.mjs` | **The fit gate.** `sheetAdmits()` plus the rules behind it — `expFloor`/`bodyExpFloor` (the JD body outranks the portal's header band), `tooSenior`, `isAzureJob`/`isGcpJob`, `isWrongCore`, `isWrongPlatformTitle`, `isSupportRole`, `isSuspectEmployer`, `dupKey`. One place decides what may enter a sheet. |
| `check-gate.mjs` | CLI wrapper over `sheetAdmits()` — `node scripts/lib/check-gate.mjs <scan-file> <job-id>` exits 0 + `PASS` or 1 + `REJECT: <reason>`. The agent pass calls this instead of judging the gate in prose. |
| `identity.mjs` | Loads `config/profile.json` (git-ignored; falls back to `config/profile.example.json`) — name, email, phone, profile folder, résumé path. |
| `reports-paths.mjs` | Resolves the date-wise output dirs under `reports_stats/<YYYY-MM-DD>/`. |
| `seen-ledger.mjs` | Cross-day dedup ledger (`makeFreshFilter`) so a sheet shows new-today only. |
| `skip-audit.mjs` | Per-run record of every rejected job and why. |
| `funnel-to-xlsx.mjs` | Funnel markdown → colour-coded Excel. |
