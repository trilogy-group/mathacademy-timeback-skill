# mathacademy_timeback — a data source skill

The meaning layer for Math Academy data inside Timeback, built to the dss estate's contract
(https://data-source-skills.vercel.app/contract). Timeback-only: readers use their Timeback
credential against Timeback's own APIs; nothing here calls Math Academy.

## What is in this folder

| Path | What |
|---|---|
| `DICTIONARY.md` | the product lens: containers, field genesis, invariants, 19 numbered traps, open questions |
| `ENABLEMENT.md` | 8 capabilities, question→call catalog, 8 worked examples with output shapes |
| `skill.template.json` → `skill.json` | the five-clause front (`what / when / why / how / feedback`), rendered by `scripts/build_front.py` |
| `reference/timeback-math-academy-courses.json` | the 23 OneRoster courses titled Math Academy (the domain of the course field) |
| `reference/course-xp-size.json` | per-course XP size, a dated Math Academy calibration for the XP-remaining estimate |
| `reference/topic-course-map.json` | topic id → majority Timeback course, a dated heuristic snapshot for example 7 |
| `feedback/worker.js`, `feedback/wrangler.toml` | the Cloudflare Worker that serves the front, the documents and the feedback wire (GitHub issues) |
| `scripts/build_front.py` | pins the live contract sha, document shas and git version into `skill.json` |
| `scripts/build_public.py` | assembles `public/` for the worker's static assets |
| `scripts/verify_predicates.py` | self-runs the registry's four keyless predicates against a deployed base |
| `BUILD-LOG.md` | dated probes behind every claim |
| `deploy.json` | base origin and feedback repo (placeholders until chosen) |

## Publish

1. Pick the origin and the feedback repo; put them in `deploy.json` and `feedback/wrangler.toml` (`REPO`).
2. Create the two labels `skill-feedback` and `mathacademy_timeback` on that repo; mint a fine-grained token with issues read/write on it.
3. `py -3 scripts/build_public.py` (renders `skill.json`, assembles `public/`).
4. `npx wrangler secret put GITHUB_TOKEN --config feedback/wrangler.toml`, then `npx wrangler deploy --config feedback/wrangler.toml`.
5. `py -3 scripts/verify_predicates.py https://<base>` — all four must pass.
6. `POST https://data-source-skills.vercel.app/dss/register` with `{name: "mathacademy_timeback", front: "<base>", owner: "<repo>", reporter: "<who>"}`; read the intake ticket at `GET https://data-source-skills.vercel.app/feedback/{number}`.
7. Re-run step 3 and redeploy whenever a document changes or the contract moves (the estate notifies the feedback wire).

## Rules this build follows

- Served documents carry meaning and method, never values read off the wire; no student names, emails or identifying rows anywhere in the served files.
- Timeback writes are never made; every route used is a GET.
- The Math Academy API was used exactly once, at build time, to ground the invariants and the two calibrated reference files; it is not part of the skill.
