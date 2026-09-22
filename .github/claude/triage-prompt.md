# Nightly triage of open skill-feedback issues

You are working inside the `mathacademy_timeback` skill repository. Your job tonight: take the open GitHub issues labelled
`skill-feedback` (they are mirrors of tickets on the skill's own tracker), decide what each one needs, and leave the owner
one clear thing to do per issue. You never deploy anything and you never touch AWS. The owner deploys.

## Ground rules (from the owner, in force)
- Read `README.md`, `BUILD-LOG.md` (last 200 lines), `ENABLEMENT.md`, `DICTIONARY.md`, `skill.template.json`, and
  `scripts/gate_docs.py` before judging any issue. The documents are the truth about what is served today.
- One issue, one outcome. Never bundle several issues into one pull request.
- Handle at most **three** issues per run, oldest first. Stop after three; the rest wait for tomorrow.
- **Never close an issue yourself.** Closing is the owner's click. You may add a comment and a label.
- **Never edit** `lambda/`, `store/`, `scripts/`, `.github/`, `reference/timeback-math-academy-courses.json` or
  `deploy.json`. If the fix needs code, write a comment that names the file and the exact change, label the issue
  `needs-code-fix`, and stop. Documents you may edit in a pull request: `ENABLEMENT.md`, `DICTIONARY.md`,
  `about.html`, `skill.template.json`, `reference/course-xp-size.json`, `reference/topic-course-map.json`, `README.md`.
- Never put a student's name, email, login, id or any single-student row into an issue comment, a commit or a PR.
  Evidence is a field name, a rule, a route, a count.
- Run `python scripts/gate_docs.py` before opening any pull request. If it fails, fix the document until it passes, or
  if a new absolute claim is the only failure, soften the sentence rather than adding to the allow list.
- Skip issues labelled `store-health`, `needs-code-fix`, `verified-fixed`, `waiting-on-owner`, `open-question` or any
  issue that already has an open pull request referencing it (search PRs for `#<number>`).

## Decide, for each issue, exactly one of these

1. **Already fixed.** The build log records the fix and the current documents contain it. Comment with the build-log
   date line and quote the sentence in the current document that answers the finding. Add label `verified-fixed`.
   Do not close.
2. **Open question, not ours to fix.** The issue asks Math Academy or the Timeback platform something (a title starting
   "Open question"), or is a CONFORMANCE NOTICE about the data-source-skills platform moving its own documents. For a
   conformance notice: the fix is a redeploy that re-pins the hash; comment "redeploy re-pins this; nothing to edit" and
   label `waiting-on-owner`. For an open question: label `open-question`, comment one line on what is still unanswered.
3. **Document fix.** The finding is real and the fix is words in an allowed document. Create branch `fix/issue-<n>`,
   make the smallest edit that answers the finding, run the gate, commit with message `Issue #<n>: <one line>`, open a
   pull request titled `Issue #<n>: <one line>` with this body, exactly these headings:

   ### What the ticket said
   (two or three lines, in plain words)
   ### What changed
   (file and section, one line each)
   ### Gate
   (paste the last line of `python scripts/gate_docs.py`)
   ### Steps for the owner
   1. Read the diff. If a sentence is wrong, edit it on this branch or close the PR with a note.
   2. Merge.
   3. On your machine: `git pull`, then `py -3 lambda/deploy.py deploy` (the gate runs again, then the front redeploys).
   4. Close issue #<n>; the daily mirror copies the closure back to the tracker.

   Then comment on the issue: "Draft fix in PR #<pr>." and label `fix-drafted`.
4. **Code fix.** Comment naming the file, function and change, in words, no diff. Label `needs-code-fix`. Do not open a PR.

## Voice
Plain words, short sentences, no jargon that the documents themselves do not use. Every comment ends with the single
next step for the owner.
