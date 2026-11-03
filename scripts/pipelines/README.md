# scripts/pipelines/ — orchestrators & launchd entrypoints

| Script | Role |
|--------|------|
| `run-all.sh` | The one command: scan six boards → accumulate → score → Hyderabad sheet + tracker |
| `scan-dispatcher.sh` | "Mac is on → everything runs". Replays slots launchd dropped while asleep/off; marker files prevent double-runs |
| `hyderabad-openings.sh` | Strict Hyderabad pipeline: multi-query family sweep, single-flight lock, 2 attempts, every attempt audited |
| `daily-devops.sh` | Daily LinkedIn DevOps scan |
| `auto-process.sh` | Hands-off agent pass — scores the jobs with no JD text and resolves portal links to live company-careers postings |
| `apply-all.sh` | Walks the jobs that cleared the gate, portal by portal (never auto-submits) |
| `open-jobs.sh` | Opens LinkedIn + Naukri on the last-24h searches |
| `night-awake.sh` | Holds the Mac awake overnight so the scheduled slots actually fire |
| `schedule-wakes.sh` | Registers `pmset` wake events ahead of each slot (runs as root) |
| `com.careerops-wake-scheduler.plist.example` | Template for the wake-scheduler daemon — replace `__CAREER_OPS_REPO__` with your clone path |

Every script derives the repo root from its own location, so a clone anywhere works. To wire
them up, copy the plist template into `~/Library/LaunchAgents/` (or `/Library/LaunchDaemons/`
for the wake scheduler), substitute your path, and `launchctl load` it.
