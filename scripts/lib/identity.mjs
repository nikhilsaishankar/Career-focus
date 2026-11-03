// identity.mjs — the one place personal details come from.
//
// Nothing in this repo hardcodes a name, an email, a phone number or a résumé
// path. Copy config/profile.example.json to config/profile.json (git-ignored)
// and fill in your own values; a fresh clone still runs off the example.
//
//   import identity from "../lib/identity.mjs";
//   identity.fullName, identity.email, identity.phone, identity.profileDir, ...

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const expand = (p) => (typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const load = (name) => {
  const p = join(repoRoot, "config", name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`⚠️  config/${name} is not valid JSON — ignoring (${e.message})`);
    return null;
  }
};

const cfg = load("profile.json") || load("profile.example.json") || {};

export const identity = {
  fullName: cfg.fullName || "Your Name",
  email: cfg.email || "you@example.com",
  phone: cfg.phone || "",
  profileDir: expand(cfg.profileDir) || join(homedir(), "main", "profile"),
  coverLetterMaster: cfg.coverLetterMaster || "Cover-Letter.md",
  coverLetterPrefix: cfg.coverLetterPrefix || "Cover-Letter",
  resumePath: expand(cfg.resumePath) || join(homedir(), "main", "profile", "Resume_DevOps_Engineer.pdf"),
  naukriUploadName: cfg.naukriUploadName || "Resume-DevOps-Engineer.pdf",
};

export default identity;
