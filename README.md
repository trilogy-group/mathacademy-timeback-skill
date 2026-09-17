# mathacademy_timeback — a data source skill

The meaning layer for Math Academy data inside Timeback, built to the dss estate's contract
(https://data-source-skills.vercel.app/contract). Timeback-only: readers use their Timeback
credential against Timeback's own APIs; readers never call Math Academy. Since 2026-09-17 the skill also
holds a store of Math Academy's own student records (store/), refreshed nightly by a scheduled Lambda
(snapshot 03:00, activity 03:45 America/Chicago), served behind the reader's Timeback token; the knowledge
map is fetched live on first request and cached.

## What is in this folder

| Path | What |
|---|---|
| `DICTIONARY.md` | the product lens: containers, field genesis, invariants, 26 numbered traps, open questions |
| `ENABLEMENT.md` | 12 capabilities, question→call catalog, 12 worked examples with output shapes |
| `store/snapshot_lib.py`, `store/agreement.py` | the store library: bulk pull, roster, match chain (known id → username → email → lookup → name), agreement rule, DynamoDB layout, activity pull |
| `lambda/nightly/handler.py`, `lambda/nightly/deploy.py` | the nightly Lambda (python3.12, 900 s; modes `snapshot` and `activity`, resumable) and its roles + EventBridge schedules |
| `store/pull_snapshot.py` | one snapshot: Math Academy bulk list (4 pages) + per-student lookups, matched to the Timeback roster (username → email → lookup → name); writes `_scratch/_snapshot_<date>.json` (PII, never committed) |
| `store/load_snapshot.py` | loads a snapshot into DynamoDB `mathacademy-timeback-skill-store` (replacing the previous one) and grants the Lambda role read access |
| `skill.template.json` → `skill.json` | the five-clause front (`what / when / why / how / feedback`), rendered by `scripts/build_front.py` |
| `reference/timeback-math-academy-courses.json` | the 23 OneRoster courses titled Math Academy (the domain of the course field) |
| `reference/course-xp-size.json` | the XP-remaining rule list: Timeback's course `totalXp` read live × share left; the no-estimate cases (no course XP, no percent yet, SAT Math Prep) |
| `reference/topic-course-map.json` | topic id → majority Timeback course, a dated heuristic snapshot for example 7 |
| `feedback/worker.js`, `feedback/wrangler.toml` | the Cloudflare Worker that serves the front, the documents and the feedback wire (GitHub issues) |
| `scripts/build_front.py` | pins the live contract sha, document shas and git version into `skill.json` |
| `scripts/build_public.py` | assembles `public/` for the worker's static assets |
| `scripts/verify_predicates.py` | self-runs the registry's four keyless predicates against a deployed base |
| `BUILD-LOG.md` | dated probes behind every claim |
| `deploy.json` | base origin and feedback repo (placeholders until chosen) |

## Where it is live (since 2026-09-16)

| | |
|---|---|
| Front | `https://vgdv4g6yf4xf6jdlbfxq5mzoou0xsegi.lambda-url.us-east-1.on.aws/skill` |
| Documents | `…/DICTIONARY.md`, `…/ENABLEMENT.md`, `…/reference/*.json` on the same origin |
| Store | `GET …/store` (status, counts, byCourse, history); `GET …/store/course/{id}`; `GET …/store/student/{sourcedId}` (or `?email=`) + `/history`, `/activity?from&to`, `/knowledge` with `Authorization: Bearer <reader's Timeback token>`; the Lambda replays the token against Timeback and serves only students it answers 200 for; Math Academy is called only for the knowledge map (cached 7 d) and a live lookup on a store miss |
| Nightly | Lambda `mathacademy-timeback-nightly` (role `team-dev-mathacademy-skill-nightly`: logs, `sat-cohort-tracker/ci` secret read, store table, self re-invoke), schedules `mathacademy-timeback-snapshot-nightly` 03:00 and `mathacademy-timeback-activity-nightly` 03:45 America/Chicago via role `team-dev-mathacademy-skill-scheduler`; `py -3 lambda/nightly/deploy.py check|invoke snapshot|invoke activity <day>|disable|enable` |
| Feedback wire | `POST …/feedback` (open, caps 200/10000) → 201; `GET …/feedback[?state=]`, `GET …/feedback/{n}` |
| Tracker | DynamoDB table `mathacademy-timeback-skill-feedback` (us-east-1), the skill's own; mirrored daily into this repo's issues by `.github/workflows/mirror-feedback.yml` using the repo's built-in token; closures on GitHub copied back |
| Hosting | AWS account 182821611732, Lambda `mathacademy-timeback-skill` (nodejs20.x, 256 MB), role `team-dev-mathacademy-skill-lambda` (PowerUserAccess boundary; logs + the two tables + GetSecretValue on `sat-cohort-tracker/ci` for the MA key) |
| Registration | `POST /dss/register` filed 2026-09-16 → estate intake ticket 1713, readable at `https://data-source-skills.vercel.app/feedback/1713` |

## Publish / redeploy (AWS path, the one in use)

1. Edit documents or template. `deploy.json` holds the base URL and repo.
2. `py -3 lambda/deploy.py deploy` — renders `skill.json` (fresh contract sha, doc shas, git version), assembles `public/`, zips handler + public, updates the function. The admin key the mirror job uses is read from `_scratch/_admin_key.txt` (random, generated at first deploy; the same value is the repo's `ADMIN_KEY` Actions secret).
3. `py -3 scripts/verify_predicates.py https://<base>` — all four must pass.
4. Commit and push so the served `gitVersion` matches a commit.
5. First-time only: `py -3 lambda/deploy.py --create-roles` before step 2, and `POST https://data-source-skills.vercel.app/dss/register` after step 3.

The Cloudflare Worker variant (`feedback/worker.js`, `feedback/wrangler.toml`) is kept as an alternative host and is not deployed.

## Rules this build follows

- Served documents carry meaning and method, never values read off the wire; no student names, emails or identifying rows anywhere in the served files.
- Timeback writes are never made; every route used is a GET.
- The Math Academy API was used exactly once, at build time, to ground the invariants and the topic-course snapshot; it is not part of the skill. The XP-remaining estimate uses Timeback's own course XP figure, read live.
