# mathacademy_timeback — enablement

What Math Academy data inside Timeback is good for, and how to put it to work. Worked examples are direct instruction: guidance, not truth. The dictionary governs meaning; the live OpenAPI files govern shape. Read both fresh.

This source answers *what a Math Academy student did, how far through their course they are, who has gone quiet, who has finished, and whether Timeback's record of their course looks coherent*, all from Timeback's own APIs with a Timeback credential and no Math Academy call. Siblings answer the other halves: **timeback_production** and **timeback_analytics** (registered at the dss estate) hold the whole learning record across every app, screen-capture minutes and waste, MAP testing and mastery; **the Math Academy API itself** holds what never reaches Timeback (estimated SAT score, exact XP remaining, course grade, engaged versus productive time, the course catalogue). Route to them when the question crosses over.

**Base:** `https://api.alpha-1edtech.ai`. Every call: `Authorization: Bearer <token>`, minted once per hour from the Cognito client-credentials endpoint (dictionary § native surface). The two OpenAPI files are keyless. Discovery is those files plus this dictionary/enablement pair. Never tell the user a capability is missing without checking the OpenAPI first.

## How to work

- **Select Math Academy explicitly.** The results container holds every app's Caliper rows. Pass `metadata.appName='Math Academy'` (or a student filter and check `metadata.appName` on each row) and say which set you read.
- **Page to `totalCount`.** `limit` caps at 3000; loop on `offset` until `offset >= totalCount` (trap 18).
- **Use course ids, never titles** (trap 1). The id list is in `reference/timeback-math-academy-courses.json` and regenerates with one call.
- **Current enrollment = active AND in its date window** (trap 2). Prefer `primary = "true"` when a student holds several.
- **Aggregation is yours.** Counts, sums and groupings are done in-context over the pages you pulled, or read from EduBridge's own daily cells. When you sum weekly facts, filter `eventType` first (trap 5). When you emit an aggregate, name the numerator, the denominator and the roster basis (which students, filtered how).
- **The task type is in the URL** (trap 7). Parse the last path segment; `lesson` is new material, `review` is spaced repetition over earlier topics.
- **Filter out test users** (trap 12) before any census: `users.metadata.isTestUser`, plus name patterns your organisation knows.
- **The students are children.** Use `user.sourcedId` as the key throughout; resolve an email to an id once, at the start, and let nothing person-bearing (name, email, Math Academy login) leave your session. Every output shape below is keyed on the opaque id for that reason (dictionary § Students are children; the front's `pii` clause).
- **The range of an absence.** "No Math Academy activity" for a student is a claim about the results container for that student in that window; say so. A student with no results may have an enrollment with no events yet (trap 3), or may be below grade 4 and never onboarded, or may be outside the credential's org. Say which container you read and over what window; nothing older than the oldest reachable result is decidable.
- **Timezone.** Pass the campus IANA timezone to EduBridge and use the same one when bucketing `scoreDate` (trap 17).
- **A permission error is a key limit, not an absence.** 401 means mint again; 403 means the credential does not cover the route; report either, never estimate past it.

## Capabilities — what you can answer here

Each is buildable by a cold agent with `GET /skill`, this pair, and a Timeback credential. This list is the claim surface.

1. **A student's Math Academy task history** — every task with type, topic, XP, accuracy and time, in a window.
2. **A student's daily and weekly Math Academy totals** — XP, questions, correct, active minutes per day.
3. **A student's current Math Academy course and how far through it they are** — course, completion percent and its age, running totals, and an estimated XP remaining with its basis named.
4. **Who has gone quiet** — students in a Math Academy class or course with no Math Academy event in N days.
5. **Who has finished their course** — completion percent at 100, and whether they have since moved.
6. **Where a student is struggling** — failed reviews, negative XP, low accuracy by topic.
7. **Whether a student's Timeback course looks wrong** — a suspect-course flag from lesson topic ids, paired with the quiet check, with its false-alarm profile stated.
8. **Estate-wide Math Academy activity for a day or a week** — every event across all students without a student list.

## Question → composition catalog

| The user asks… | Compose |
|---|---|
| "What did this student do on Math Academy this week?" | results by `student.sourcedId` + `scoreDate>=`, parse URL for type/topic, join line item titles (ex. 1) |
| "How many minutes and XP per day?" | EduBridge `/analytics/activity` by student and range, read `factsByApp[day].Math["Math Academy"]` (ex. 2) |
| "What course is she in and how far along?" | enrollments by user → active in-window Math Academy class → `metadata.pctCompleteApp`, `pctCompleteAppUpdatedAt`, `metrics`; course id → estimate (ex. 3) |
| "Who in this class hasn't touched Math Academy in two weeks?" | class → students → per-student latest result; or estate-wide results since day D → set of active students; difference against the class roster (ex. 4) |
| "Who finished?" | enrollments in Math Academy classes with `pctCompleteApp = 100`; check for a newer enrollment (ex. 5) |
| "Where is he struggling?" | results by student, keep `review` rows with `xp < 0` or `score < 60`, group by topic title (ex. 6) |
| "Is anyone in the wrong course?" | topic map from estate-wide lesson events; per student share of topics pointing elsewhere; pair with quiet check (ex. 7) |
| "How much Math Academy happened yesterday across the school?" | estate-wide results with `metadata.appName` and `scoreDate>=`, group by student and course (ex. 8) |

## Worked examples

Every call is a direct native request against the base URL with the bearer header. Filters are plain query-string parameters. Dates in filters are ISO; `scoreDate` compares as a timestamp, so `>= '2026-09-01'` means midnight UTC.

### 1 · Task history — "What did this student do on Math Academy this week?"

```
# start from the student's Timeback id (user.sourcedId). Only if a person handed you an email, resolve it ONCE and carry the id from then on:
GET /ims/oneroster/rostering/v1p2/users/?filter=email='<student email>'          # → users[0].sourcedId ; the email does not travel further
GET /ims/oneroster/gradebook/v1p2/assessmentResults
      ?filter=student.sourcedId='<sid>' AND scoreDate>='<YYYY-MM-DD>'
      &sort=scoreDate&orderBy=desc&limit=3000&offset=0                            # page until offset >= totalCount
      # keep rows where metadata.appName == 'Math Academy'
GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<assessmentLineItem.sourcedId>   # title = topic name (one per row; cache)
```

- Parse `metadata.originalObjectId`: `/topics/<topicId>/<type>` or `/tasks/<taskId>/placement`.
- Read `metadata.xp` (signed), `score`, `metadata.totalQuestions`, `metadata.correctQuestions` (may be null), `scoreDate` (UTC completion time).
- For seconds per task, read the student's weekly facts (ex. 2, step B) and join `TimeSpentEvent` rows on timestamp and topic title; the result row itself carries no duration.
- Failure mode: treating `dateLastModified` as the activity time (it is ingestion time), or reading `review` rows as new lessons.

Output shape: one row per task — `scoreDate (UTC)`, `type`, `topicId`, `topicTitle`, `xp (int, signed)`, `score (0–100 or null)`, `correct/total`, `attempt`, `pctCompleteApp (string %)`.

VERIFIED RUN (build, 2026-09-16): the calls executed against one active student and returned the shape above, with `review` and `lesson` rows interleaved and a minority of rows carrying `score: null`.

### 2 · Daily totals — "How many minutes and XP per day?"

```
A. GET /edubridge/analytics/activity?studentId=<sid>&startDate=<YYYY-MM-DD>T00:00:00Z&endDate=<YYYY-MM-DD>T23:59:59Z&timezone=<IANA>
      # facts[<day>].Math.activityMetrics / timeSpentMetrics ; factsByApp[<day>].Math["Math Academy"] isolates the app
B. GET /edubridge/analytics/facts/weekly?studentId=<sid>&weekDate=<any date in the week>&timezone=<IANA>
      # facts[] = event rows; keep app == 'Math Academy'; eventType 'ActivityEvent' for XP/questions, 'TimeSpentEvent' for activeSeconds
```

- A gives the day rollup; B gives the events behind it. B has two rows per task (trap 5); `activeSeconds` is a string.
- `wasteSeconds` is always 0 for Math Academy (trap 4): do not report it as clean behaviour.
- Aggregate labels: XP = sum of `ActivityEvent.xpEarned`; minutes = sum of `TimeSpentEvent.activeSeconds` / 60; basis = this student's Math Academy rows in the requested window and timezone.
- Failure mode: omitting `timezone` and getting UTC days; summing all fact rows and doubling the event count.

Output shape: one row per day — `date`, `xpEarned`, `correct/total`, `masteredUnits`, `activeMinutes`, plus per-day `apps[]` confirming only `Math Academy` contributed.

VERIFIED RUN (build, 2026-09-16): A and B executed for one student and one week; the sum of `ActivityEvent.xpEarned` per day equalled A's `xpEarned` for that day on every day checked.

### 3 · Current course and progress — "What course is she in and how far along?"

```
GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>' AND status='active'&limit=3000
      # keep rows whose class.name contains 'Math Academy' and whose beginDate..endDate contains today; prefer primary == "true"
      # read course.sourcedId, course.name, metadata.pctCompleteApp, metadata.pctCompleteAppUpdatedAt, metadata.metrics.totalXp / totalLessons
GET /ims/oneroster/rostering/v1p2/courses/<course.sourcedId>          # metadata.metrics.totalXp (Timeback's figure; trap 11)
```

- Progress is `metadata.pctCompleteApp` (integer here). Its age is `pctCompleteAppUpdatedAt`. Absent means no event yet (trap 3).
- Estimated XP remaining: look the enrollment's `course.sourcedId` up in `reference/course-xp-size.json` (keyed by course id, one row per course) and follow its `rules` in order: a row with `sizeXp` → `sizeXp × (1 − pct/100)`, basis "calibrated 2026-09-16"; a row without `sizeXp` → the Timeback lower bound `course.metadata.metrics.totalXp × (1 − pct/100)`, basis "timeback lower bound"; a row whose `use` is `never` (SAT Math Prep only, which reports an estimated SAT score instead of progress) → no estimate at all; an id not in the file → regenerate the courses reference and treat as unsized. Always name the basis. Never present either figure as Math Academy's.
- Failure mode: taking the first active enrollment (an old course still `active`), or dividing enrollment `totalXp` by course `totalXp` to get progress.

Output shape: `course.sourcedId`, `course.name`, `pctCompleteApp`, `pctCompleteAppUpdatedAt`, `enrollment.beginDate`, `metrics.totalXp`, `metrics.totalLessons`, `estRemaining {value | null, basis: "calibrated <date>" | "timeback lower bound" | "none: SAT Math Prep reports a score, not progress"}`.

VERIFIED RUN (build, 2026-09-16): executed for one student; the enrollment percent matched the `pctCompleteApp` on that student's latest result.

### 4 · Who has gone quiet — "Who in this class hasn't touched Math Academy in two weeks?"

```
A. GET /ims/oneroster/rostering/v1p2/classes/?filter=title~'Math Academy'&limit=3000        # or a known class id
B. GET /ims/oneroster/rostering/v1p2/enrollments/?filter=class.sourcedId='<classId>' AND status='active'&limit=3000
      # keep rows with today inside beginDate..endDate → the roster (user.sourcedId)
C. GET /ims/oneroster/rostering/v1p2/classes/<classId>/students?limit=3000                    # key is `users`: email, grades, metadata.isTestUser
D. GET /ims/oneroster/gradebook/v1p2/assessmentResults
      ?filter=metadata.appName='Math Academy' AND scoreDate>='<today − N days>'&limit=3000&offset=0   # page; collect student.sourcedId
      # quiet = roster − active set
```

- D is one paged read for the whole estate (about two thousand rows a day, order 10,000 a week); it replaces per-student loops. For one student, ex. 1 with `limit=1&orderBy=desc` gives the last event directly.
- Aggregate labels: numerator = roster students with no Math Academy result in the window; denominator = active in-window enrollments of the class; basis = OneRoster enrollments, test users excluded (say whether you excluded them).
- Failure mode: counting `active` enrollments whose `endDate` has passed; reading the class by title and merging two spellings; forgetting that "no result" is a claim about the results container only.

Output shape: one row per quiet student — `user.sourcedId`, `course.sourcedId`, `course.name`, `enrollment.beginDate`, `lastMathAcademyResult (date or null in window)`, `pctCompleteApp`. No email, no name: the recipient resolves the id if they are entitled to (dictionary § Students are children).

VERIFIED RUN (build, 2026-09-16): D returned pages of the documented shape for a 14-day window; A–C executed for one class.

### 5 · Who finished — "Who has completed their Math Academy course?"

```
GET /ims/oneroster/rostering/v1p2/enrollments/?filter=class.sourcedId='<classId>' AND status='active'&limit=3000
      # keep metadata.pctCompleteApp == 100
GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>'&limit=3000
      # does a newer Math Academy enrollment exist (beginDate after pctCompleteAppUpdatedAt)? if not, the student finished and was not moved
```

- A finished course with no successor enrollment is the case the platform's progression should have handled; report it as a finding with the enrollment id, never as a student's fault.
- Failure mode: using `metrics.totalXp` against course `totalXp` as "finished" (trap 11).

Output shape: `user.sourcedId`, `course.name`, `pctCompleteAppUpdatedAt`, `hasNewerMathAcademyEnrollment (bool)`.

VERIFIED RUN (build, 2026-09-16): executed over one class; the shape held.

### 6 · Where a student is struggling — "Which topics is he failing?"

```
GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND scoreDate>='<date>'&limit=3000
      # keep metadata.appName == 'Math Academy'
      # struggling rows: metadata.xp < 0 (failed review), or score < 60, or attempt > 1
      # group by topicId (from the URL); title from the line item
```

- Negative XP is a failed review; a failed lesson awards 0 (trap: XP is signed). `score` null rows carry no accuracy signal (trap 9).
- Aggregate labels: per topic, count of failed attempts over count of attempts, this student, this window.
- Failure mode: treating `review` failures on an earlier course's topic as a gap in the current course; they are spaced-repetition checks (trap 8).

Output shape: one row per topic — `topicId`, `topicTitle`, `attempts`, `failed`, `lastType`, `lastScoreDate`.

VERIFIED RUN (build, 2026-09-16): executed for one student over one month; the shape held.

### 7 · Suspect course — "Is anyone in the wrong course?"

The filed course is the enrollment's course, not Math Academy's (dictionary rule 2, trap 10). Timeback alone can only infer a disagreement from what the student is being taught.

```
A. Build the topic map (once per run, estate-wide):
   GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<today − 14 days>'&limit=3000&offset=0   # page
      # keep rows whose URL type is lesson | quiz | multistep (never review)
      # for each student: current Math Academy enrollment course (ex. 3), skip isTestUser
      # for each topicId: count distinct students per enrolled course; keep topics with >= 5 students and top course share >= 0.8
B. Per student: over their lesson/quiz/multistep topics that are in the map, share whose mapped course != the student's enrolled course
      # flag when share >= 0.8 and at least 3 mapped topics; report the course the topics point at
C. Pair with ex. 4: a student with no events in the window cannot be checked this way and is reported as "quiet, unchecked"
```

- This is a **heuristic**. Its known false alarms are students in a grade-N class whose lesson topics map to grade N−1 or N+1, because adjacent Math Academy courses share topics; report "suspect: topics point at <course>", never "wrong". A definitive answer needs the Math Academy course from Math Academy, outside this skill.
- Half of the students whose course was known to disagree during the build had no recent events at all; that is why step C is part of the example.
- The pre-built map in `reference/topic-course-map.json` is a dated snapshot of step A; regenerate it rather than trust it.
- Aggregate labels: flagged over checkable (students with ≥ 3 mapped lesson topics in the window), roster basis stated.

Output shape: one row per flagged student — `user.sourcedId`, `enrolledCourse`, `topicsPointAt`, `share`, `mappedTopics`, `lastEvent`.

VERIFIED RUN (build, 2026-09-16): A and B executed over 14 days of estate-wide events; the map and the flags came out in the shape above, and the flag set was compared with a Math Academy-side truth list during the build to state the false-alarm profile above.

### 8 · Estate-wide day — "How much Math Academy happened yesterday?"

```
GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<day>T00:00:00Z' AND scoreDate<='<day>T23:59:59Z'&limit=3000&offset=0   # page
      # group by student.sourcedId; join enrollments for course; sum metadata.xp; count by URL type
```

- Aggregate labels: events, students, XP by course; basis = every Caliper result with `appName` Math Academy in the UTC day, test users excluded or not (say which).
- Failure mode: taking one page as the day (trap 18); mixing UTC and campus days (trap 17).

Output shape: one row per course — `course.sourcedId`, `course.name`, `students`, `events`, `xp`, `lessons`, `reviews`, `quizzes`, `placements`.

VERIFIED RUN (build, 2026-09-16): executed for one UTC day; the shape held.

## Cross-system notes

- The Math Academy task id and topic id inside the task URL are this source's only handles into Math Academy. They are claims; matching them to Math Academy's records is the caller's, over both systems.
- Timeback never receives Math Academy's estimated SAT score, exact XP remaining, course grade, engaged/productive split, daily goals, or its course catalogue. A question that needs them routes to the Math Academy API.
- Waste and integrity signals for Math Academy sessions live in timeback_analytics' capture estate, not here (trap 4).

## Improvement loop

File feedback on this skill's own wire, published in the `/skill` front under `feedback`: `POST <feedback.report>` with JSON `{title, body, reporter, kind?}` files a public, attributed ticket on this skill's own tracker and returns its number and URL; every ticket is mirrored daily into a GitHub issue on the repo named in the front (labels `skill-feedback` + `mathacademy_timeback`) and closures there are copied back. `GET <feedback.open>` lists the open items and `?state=closed|all` the rest; `GET <feedback.open>/{number}` shows one ticket with its thread. A report shaped `From: / Problem (dated evidence): / Ask: / Acceptance (a falsifiable test the fix must pass):` graduates straight into an eval case. Evidence in a ticket is a class, a field, a rule, or the query that measures it; never a student's name, contact, or an identifying row, and never a figure read off the wire. A question this pair cannot answer, or a report unacted on, is this skill failing its contract; say so.

Standing open items, each a ticket on this wire: **#7** (which course ids progression honours), **#8** (Math Academy student id in Timeback), **#9** (null scores), **#10** (retention), **#11** (duplicate time rows).
