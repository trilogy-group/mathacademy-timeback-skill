# Next steps: nightly triage of skill-feedback issues (parked 2026-09-22)

Goal: open issues on this repo stop sitting for days. A scheduled Claude job reads each open `skill-feedback` issue,
decides it, and leaves the owner ONE step per issue (a PR to merge, or a comment). It never closes issues, never edits
code, never deploys. The owner merges and runs `py -3 lambda/deploy.py deploy`.

## Already in the working tree (uncommitted, not pushed)
- `.github/workflows/pr-gate.yml` — runs `scripts/gate_docs.py` and `scripts/build_front.py` on every pull request.
- `.github/claude/triage-prompt.md` — the rules the nightly agent follows (3 issues a night, 4 outcomes, no closing, no code, no student data).

## Owner's one-time setup (about 10 minutes)
1. Install the Claude GitHub App on this repo: https://github.com/apps/claude -> Install -> select trilogy-group/mathacademy-timeback-skill (an org admin may need to approve).
2. Create an API key at https://platform.claude.com and add it as this repo's Actions secret `ANTHROPIC_API_KEY`
   (Settings -> Secrets and variables -> Actions). Alternative: run `claude setup-token` locally and add `CLAUDE_CODE_OAUTH_TOKEN` instead.
3. Decide nightly or on-demand, then add `.github/workflows/triage-fixes.yml` (YAML below; delete the two `schedule` lines for on-demand only).
4. Create labels on the repo: `verified-fixed`, `fix-drafted`, `needs-code-fix`, `waiting-on-owner`, `open-question`.
5. Watch the repo (Custom: Issues + Pull requests) with email on in GitHub notification settings. Every PR and comment then arrives by email with its steps inside.
6. Commit and push the three files. Run the workflow once by hand from the Actions tab with `max_issues` = 1 and read the first PR.

## What each PR will say
Title `Issue #<n>: <one line>`; body: what the ticket said, what changed, the gate result, and four steps:
read the diff -> merge -> `git pull` + `py -3 lambda/deploy.py deploy` on the owner's machine -> close the issue (the daily mirror copies the closure back).

## Also worth fixing when there is time
- The tracker's list route reports all 58 tickets as `open` while GitHub shows 38 closed: the mirror's close-back is not landing or the list's state field is stale. File it on the feedback wire.
- Issues #44-#59 (rounds 3-7, 18 Sept) are recorded as fixed in BUILD-LOG.md but never closed on GitHub; the triage job's first nights will label them `verified-fixed` for a one-click close.
- Store health issue #61 (one student error in the 21 Sept activity pull): tonight's overlap re-pull retries it; if it recurs, `py -3 lambda/nightly/deploy.py check` and the nightly Lambda's CloudWatch log.

## The workflow (paste as `.github/workflows/triage-fixes.yml`)
```yaml
name: nightly triage of skill-feedback issues (draft fixes as PRs)
on:
  schedule:
    - cron: "0 6 * * *"        # 06:00 UTC, after the 05:17 mirror. Delete these two lines for on-demand only.
  workflow_dispatch:
    inputs:
      max_issues:
        description: "how many issues to handle this run"
        default: "3"
jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - name: gate passes on main before any drafting
        run: python scripts/gate_docs.py
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Follow .github/claude/triage-prompt.md exactly. Handle at most ${{ github.event.inputs.max_issues || '3' }} issues.
            Repository: ${{ github.repository }}. Use gh for issues, labels, branches and pull requests.
            Run `python scripts/gate_docs.py` before any PR. End with a one-line summary per issue handled.
          claude_args: |
            --model claude-fable-5-1
            --max-turns 80
            --allowedTools "Bash(gh:*),Bash(git:*),Bash(python:*),Read,Edit,Write,Glob,Grep,mcp__github__*"
```
Do not pass `github_token` to the action: PRs opened with it would not trigger the PR gate. Sources: https://code.claude.com/docs/en/github-actions.md
