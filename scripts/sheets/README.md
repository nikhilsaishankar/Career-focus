# scripts/sheets/ — Excel outputs

- `build-hyderabad-sheet.mjs` — the main sheet: aggregates `data/*-scan.json` + the durable
  pool, applies the `lib/job-filters.mjs` gate, dedups across days, and writes
  `reports_stats/<date>/HYDERABAD.xlsx`. Zero tokens — pure aggregation.
- `build-tracker.mjs` — date-wise application tracker (`TRACKER.xlsx`): what is applied,
  what is ready to apply.
