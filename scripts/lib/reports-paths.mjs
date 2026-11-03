// reports-paths.mjs — date-wise output folders under reports_stats/<YYYY-MM-DD>/.
// Each day gets its own folder so sheets never pile up across days (avoids confusion).
//   reports_stats/2026-06-16/module01-LinkedIn.xlsx   <- the human view you open
//   reports_stats/2026-06-16/md/module01-LinkedIn.md  <- the appendable source
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Local (machine timezone, e.g. IST) YYYY-MM-DD — NOT UTC, so the folder name
// matches the day you actually see on the clock.
export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Resolve today's date folder. Per-module sheets are DEPRECATED — everything now lives in the
// single MASTER.xlsx workbook (one tab per platform, with a Tier column). So reports_stats/<date>/
// holds ONLY MASTER.xlsx; any legacy module md/xlsx/json writes are routed to a hidden scratch
// under data/ (gitignored) so no Tier/module folders ever appear in reports_stats.
export function reportPaths(date = today()) {
  const dir = join(ROOT, "reports_stats", date);
  mkdirSync(dir, { recursive: true });
  const scratch = join(ROOT, "data", ".module-scratch", date);
  mkdirSync(scratch, { recursive: true });
  return {
    date,
    dir,
    mdDir: scratch,
    md: (file) => join(scratch, file),
    xlsx: (file) => join(dir, file),
    // Deprecated per-module folder — now a flat hidden scratch under data/ (not reports_stats).
    mod: (_tier, moduleFolder) => {
      const pdir = join(scratch, moduleFolder);
      mkdirSync(pdir, { recursive: true });
      return {
        dir: pdir,
        md: (file) => join(pdir, file),
        xlsx: (file) => join(pdir, file),
        json: (file) => join(pdir, file),
      };
    },
  };
}
