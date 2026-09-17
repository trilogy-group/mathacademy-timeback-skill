# mathacademy_timeback — enablement

What Math Academy data inside Timeback is good for, and how to put it to work. Worked examples are direct instruction: guidance, not truth. The dictionary governs meaning; the live OpenAPI files govern shape. Read both fresh.

This source answers *what a Math Academy student did, how far through their course they are, who has gone quiet, who has finished, where a student is struggling, how a student's Math Academy history unfolded, whether Timeback's record of their course looks coherent, and, from a store refreshed nightly, what Math Academy itself says about the student (true course, exact XP remaining, grade, SAT estimate, engaged versus productive time per task, course history, and the knowledge map on demand)*, all with a Timeback credential and no Math Academy call by the reader. Siblings answer the other halves: **timeback_production** (front `https://timeback-loops-k8.vercel.app/dss/timeback_production/skill`) and **timeback_analytics** (front `https://platform.timeback.com/mcps/analytics/skill`) hold the whole learning record across every app, MAP testing and mastery, screen-capture minutes and waste; **the Math Academy API itself** holds only what is fresher than last night or never pulled (the course catalogue, a day the store did not pull), reached as a one-off per § One-off exact figures. Route to them when the question crosses over.

**Base:** `https://api.alpha-1edtech.ai`. Every call: `Authorization: Bearer <token>`, minted once per hour from the Cognito client-credentials endpoint with the one POST a read-only reader makes (dictionary § native surface); cache the token, mint again on 401, retry a connection reset or 5xx once. The two OpenAPI files are keyless. Discovery is those files plus this dictionary/enablement pair. Never tell the user a capability is missing without checking the OpenAPI first.

## How to work

- **Select Math Academy explicitly, by equality.** The results container holds every app's Caliper rows, and other apps' rows may carry no `appName` at all. Filter `metadata.appName='Math Academy'` on the wire (combined with a student filter when you have one) and check `metadata.appName == 'Math Academy'` on each row you keep (trap 22).
- **Page to `totalCount`.** `limit` caps at 3000; loop on `offset` until `offset >= totalCount` (trap 18).
- **Use course ids, never titles, and expect many sections per course** (trap 1). "The X class" is every class whose `course.sourcedId` is X: `classes/?filter=course.sourcedId='X'` returns them in one call.
- **Current enrollment = active AND in its date window** (trap 2); a `tobedeleted` seat is never current. Rosters come from enrollments, never from the class students route (trap 20). Where a student holds two current Math Academy enrollments, report both (invariant 5); do not rely on `primary`.
- **Progress comes from the newest result**, `metadata.pctCompleteApp` on the latest Math Academy result for that course, with the enrollment's copy as a convenience only (trap 3).
- **Where an event was filed is on its line item** (trap 21), not on the student's current enrollment. Attribute events to courses through line items.
- **Aggregation is yours.** Counts, sums and groupings are done in-context over the pages you pulled, or read from EduBridge's own cells. When you sum weekly facts, filter `eventType` first and join time rows to results on `datetime` (traps 5, 26). Active minutes are a floor (invariant 1). When you emit an aggregate, name the numerator, the denominator and the roster basis (which students, filtered how).
- **The task type is in the URL** (trap 7). `lesson` is new material, `review` is spaced repetition over earlier topics, and negative XP means the task was failed whatever its type. Quiz URLs do not carry a topic id (trap 25).
- **Filter out test users** (trap 12) before any roster census. The only served flag is `users.metadata.isTestUser`; use it and say that you did. A reader must not inspect names to guess (§ Students are children), so a flagged share is the floor of the test population, not its size. They dominate rosters and barely appear in activity, so state whether a count is of the roster or of activity.
- **The students are children.** Use `user.sourcedId` as the key throughout; resolve an email to an id once, at the start; let nothing person-bearing leave your session; scrub cached responses (dictionary § Students are children, trap 24).
- **The range of an absence.** "No Math Academy activity" is a claim about the results container, for that student, filtered to Math Academy, in that window, under a key known to cover them. Say it that way. Days absent from an EduBridge object are days with no activity, not zeros.
- **Timezone.** Nothing served tells you a student's zone. Use the school's local zone if you know it, otherwise UTC on both OneRoster and EduBridge, and say which (trap 17).
- **A permission error is a key limit, not an absence.** 401 means mint again; 403 means the credential does not cover the route; report either, never estimate past it.
- **The store is dated.** Math Academy's own figures (true course, exact XP remaining, grade, SAT estimate) come from this skill's snapshot store (ex. 10), read with the same Timeback token; print `snapshotAt` beside every figure from it, and use Timeback's live containers for anything about today.

## Capabilities — what you can answer here

Each is buildable by a cold agent with `GET /skill`, this pair, and a Timeback credential. This list is the claim surface.

1. **A student's Math Academy task history** — every task with type, topic, XP, accuracy and (where a time row exists) time, in a window.
2. **A student's daily and weekly Math Academy totals** — XP, questions, correct, active minutes per day.
3. **A student's current Math Academy course and how far through it they are** — course, completion percent and its age, and an estimated XP remaining with its basis and its known bias named.
4. **Who has gone quiet** — students in a Math Academy course (all its sections) with no Math Academy event in N days.
5. **Who has finished their course** — newest result at 100, and whether they have since been moved.
6. **Where a student is struggling** — failed tasks and low accuracy by topic, and whether a failed topic was re-taught and passed.
7. **Whether a student's Timeback course looks wrong** — a suspect-course flag from lesson topic ids, with its uncheckable and quiet buckets named and its false-alarm profile stated.
8. **Estate-wide Math Academy activity for a day or a week** — every event across all students, attributed to the course it was filed under.
9. **A student's Math Academy timeline** — every seat they have held, the events filed under each (including under deleted seats), the percent reached, and the gaps.
10. **Math Academy's own figures for a student, as of last night** — the course Math Academy is really running them in, exact XP remaining, progress, grade and letter grade, estimated SAT score, account state, and whether the Timeback seat agrees; from this skill's nightly store, dated, behind the reader's Timeback token, with no Math Academy call by the reader.
11. **Engaged versus productive time per task** — Math Academy's three clocks (elapsed, engaged, productive) for every task on the days the store pulled, plus a student's nightly course history (course changes, completion dates) since the store began.
12. **The knowledge map** — per-topic retention (stability 0–1) for the student's course and its prerequisite courses, fetched live once on request and cached for seven days.

## Question → composition catalog

| The user asks… | Compose |
|---|---|
| "What did this student do on Math Academy this week?" | results by `student.sourcedId AND metadata.appName AND scoreDate>=`, parse URL for type/topic, join line item titles (ex. 1) |
| "How many minutes and XP per day?" | EduBridge `/analytics/activity` by student and range, read `factsByApp[day].Math["Math Academy"]` (ex. 2) |
| "What course is she in and how far along?" | enrollments by user → current Math Academy seats → newest result's `pctCompleteApp` for that course → live course `totalXp` → estimate with basis (ex. 3) |
| "Who in this course hasn't touched Math Academy in two weeks?" | every section by `course.sourcedId` → active in-window enrollments → estate-wide results since day D → roster minus active set (ex. 4) |
| "Who finished?" | roster → newest result per student → `pctCompleteApp` 100 → newer Math Academy seat or not (ex. 5) |
| "Where is he struggling, and did he recover?" | results by student, failed tasks by topic, lesson-after-failed-review detector (ex. 6) |
| "Is anyone in the wrong course?" | topic map from estate-wide lesson/multistep events by line-item course; per student share pointing elsewhere; uncheckable, quiet and unenrolled buckets (ex. 7) |
| "How much Math Academy happened yesterday across the school?" | estate-wide results with `metadata.appName` and `scoreDate` bounds, course from line items via per-course line-item listing (ex. 8) |
| "Tell me this student's whole Math Academy story." | all-time results + all Math Academy enrollments + line items → timeline (ex. 9) |
| "What is her EXACT XP remaining / true course / SAT score / grade?" | the store: `GET <front base>/store/student?email=` with your Timeback token (ex. 10); dated as of `snapshotAt` |
| "Is Timeback's course for this student the one Math Academy runs?" | the store's `courseAgreement` (ex. 10): definitive as of the snapshot, unlike the topic heuristic of ex. 7 |
| "Was he actually paying attention? How much of the time was productive?" | the store's `…/activity?from=&to=` (ex. 11): Math Academy's elapsed / engaged / productive per task, joined to Timeback's rows by task id |
| "When did she change course on Math Academy, and when did she finish the old one?" | the store's `…/history` (ex. 11) for nights since the store began; ex. 9 (Timeback results) for anything earlier |
| "What does this student actually know? Where is she weak?" | the store's `…/knowledge` (ex. 12): one live call on first ask, cached 7 days; never loop it over a roster |
| "I need it fresher than last night" | one direct Math Academy call with the organisation's Math Academy key (§ One-off exact figures), never a loop |

## Worked examples

Every call is a direct native request against the base URL with the bearer header. Filters are plain query-string parameters, URL-encoded whole. Dates in filters are ISO; `scoreDate` compares as a timestamp, so `>= '2026-09-01'` means midnight UTC.

### 1 · Task history — "What did this student do on Math Academy this week?"

```
# start from the student's Timeback id (user.sourcedId). Only if a person handed you an email, resolve it ONCE and carry the id from then on:
GET /ims/oneroster/rostering/v1p2/users/?filter=email='<student email>'          # → users[0].sourcedId ; the email does not travel further
GET /ims/oneroster/gradebook/v1p2/assessmentResults
      ?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy' AND scoreDate>='<YYYY-MM-DD>'
      &sort=scoreDate&orderBy=desc&limit=3000&offset=0                            # page until offset >= totalCount
GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<assessmentLineItem.sourcedId>   # title = topic name, course = filed course (one per row; cache)
```

- Parse `metadata.originalObjectId`: `/topics/<topicId>/<type>` for lesson, review, quiz, multistep; `/tasks/<taskId>/<type>` (no topic) for placement, exam, supplemental. Quiz ids in the topic slot are quiz instances, not topics (trap 25).
- Read `metadata.xp` (signed; negative = failed), `score` (null = zero correct), `metadata.totalQuestions`, `metadata.correctQuestions`, `scoreDate` (UTC completion time), `metadata.pctCompleteApp` (may be absent).
- For seconds per task, read the student's weekly facts (ex. 2, step B) and join `TimeSpentEvent` rows on `datetime` = `scoreDate`; some tasks have no time row (invariant 1). Never join on `activityName` (trap 26).
- Failure mode: treating `dateLastModified` as the activity time (it is ingestion time, sometimes days late); reading `review` rows as new lessons; reading a null score as missing.

Output shape: one row per task — `scoreDate (UTC)`, `type`, `topicId (null for placement/exam/supplemental; quiz-instance id for quiz)`, `title`, `filedCourseSourcedId`, `xp (int, signed)`, `score (0–100, null = 0 correct)`, `correct/total`, `attempt`, `pctCompleteApp (string % or absent)`, `activeSeconds (or null)`.

VERIFIED RUN (build 2026-09-16; four cold runs 2026-09-17): the calls executed and returned the shape above; the cold runs met every URL type including exam and supplemental, negative XP on lessons, and tasks without a time row.

### 2 · Daily totals — "How many minutes and XP per day?"

```
A. GET /edubridge/analytics/activity?studentId=<sid>&startDate=<YYYY-MM-DD>T00:00:00Z&endDate=<YYYY-MM-DD>T23:59:59Z&timezone=<IANA or UTC>
      # factsByApp[<day>].Math["Math Academy"].activityMetrics / timeSpentMetrics  — the Math Academy cell; facts[<day>].Math mixes apps (trap 23)
B. GET /edubridge/analytics/facts/weekly?studentId=<sid>&weekDate=<any date in the week>&timezone=<same zone>
      # facts[] = event rows; keep app == 'Math Academy'; eventType 'ActivityEvent' for XP/questions, 'TimeSpentEvent' for activeSeconds; datetime = scoreDate
```

- A gives the day rollup; B gives the events behind it. B has one ActivityEvent row per task and a TimeSpentEvent row for most (traps 5, 26); `activeSeconds` is a string. Days with no activity are absent from A, not zero.
- `wasteSeconds` is always 0 for Math Academy (trap 4): do not report it as clean behaviour.
- Aggregate labels: XP = sum of `ActivityEvent.xpEarned`; minutes = sum of `TimeSpentEvent.activeSeconds` / 60, a floor; basis = this student's Math Academy rows in the requested window and zone.
- Failure mode: omitting `timezone` and getting UTC days without saying so; summing all fact rows and doubling the event count; reading `facts[day].Math` as Math Academy alone when Math Raiders contributed.

Output shape: one row per active day — `date`, `xpEarned`, `correct/total`, `masteredUnits`, `activeMinutes (floor)`, `apps[]` for the Math cell.

VERIFIED RUN (build 2026-09-16; cold runs 2026-09-17): A and B executed; daily XP, questions, correct and mastered units equalled the summed result rows on every day checked; minutes matched the time rows to the second where a time row existed.

### 3 · Current course and progress — "What course is she in and how far along?"

```
GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>' AND status='active'&limit=3000
      # keep rows whose course.name starts 'Math Academy' and whose beginDate..endDate contains today → the current seat(s); report both if two
GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy'&sort=scoreDate&orderBy=desc&limit=20
      # newest result whose metadata.pctCompleteApp is present → candidate progress; its scoreDate → the progress's age
GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<that result's assessmentLineItem.sourcedId>
      # its course.sourcedId MUST equal the seat's course.sourcedId; if not, the percent belongs to another course (see below)
GET /ims/oneroster/rostering/v1p2/courses/<course.sourcedId>          # metadata.metrics.totalXp, read live (trap 11)
GET <front base>/store/student/<sid>   (Authorization: Bearer <your token>)   # optional: the exact figure and the definitive course check, dated (ex. 10)
```

- Progress is the newest result's `pctCompleteApp` (string) **whose line item is filed under the seat's course**. A student moved between courses routinely has their newest percent filed under the old course (traps 10 and 21): a Prealgebra 100 next to an Algebra I seat is not "Algebra I complete", it is "the events are still landing under Prealgebra". In that case report `estRemaining.basis = "none: newest percent belongs to <line item course.sourcedId>"` and flag the seat; the store's `courseAgreement` (ex. 10) says whether Math Academy agrees with the seat. The enrollment's `metadata.pctCompleteApp` is a convenience that is often absent (trap 3); use it only when no percent-bearing result exists for the seat's course, and say so. The percent's age is the result's `scoreDate`.
- Estimated XP remaining: `course.metadata.metrics.totalXp × (1 − pct/100)`, basis "timeback course XP", per the rules in `reference/course-xp-size.json` (no estimate when the percent belongs to another course, when the course carries no `totalXp`, when no percent exists yet, or on SAT Math Prep). Where the store holds the student, its `xpRemaining` is the exact figure as of `snapshotAt`; show it beside the estimate with its date. **State the bias**: the estimate runs low for most students, typically by a fifth to nearly half, because Math Academy awards extra XP on failed reviews; present it as a band, never as the figure. Never present it as Math Academy's number.
- Do not report the enrollment's `metrics.totalXp` as XP earned: it is a course-size snapshot or an unexplained figure, not a running total (dictionary § enrollment). XP earned under a seat is the signed sum of result `xp` for that seat (ex. 9).
- Failure mode: taking the first active enrollment (an old course still `active`); trusting `primary`; dividing anything by course `totalXp` to get progress.

Output shape: per current seat — `course.sourcedId`, `course.name`, `enrollment.beginDate`, `pct (from newest result filed under this course)`, `pctAsOf (scoreDate)`, `estRemaining {value | null, basis: "timeback course XP" | "none: newest percent belongs to <course.sourcedId>" | "none: course has no totalXp" | "none: no percent yet" | "none: SAT Math Prep reports a score", biasNote}`, `storeExact {xpRemaining, asOf} | null`.

VERIFIED RUN (build 2026-09-16; cold runs 2026-09-17): executed; the newest result's percent matched the enrollment's copy where the copy existed and was present where the copy was missing. A cold run on 2026-09-17 evening met the "percent belongs to another course" case on the first student it picked (a Prealgebra 100 under an Algebra I seat), which is why the line-item step is now mandatory; on the next student the estimate ran about a quarter low against the store's exact figure, inside the stated band.

### 4 · Who has gone quiet — "Who in this course hasn't touched Math Academy in two weeks?"

```
A. GET /ims/oneroster/rostering/v1p2/classes/?filter=course.sourcedId='<courseId>'&limit=3000      # every section (trap 1)
B. for each class: GET /ims/oneroster/rostering/v1p2/enrollments/?filter=class.sourcedId='<classId>' AND status='active'&limit=3000
      # keep rows with today inside beginDate..endDate → the roster (user.sourcedId); this, not the students route, is the roster (trap 20)
C. for each class: GET /ims/oneroster/rostering/v1p2/classes/<classId>/students?limit=3000
      # key is `users`; use ONLY to resolve roster ids to metadata.isTestUser (it also returns users whose enrollment is deleted)
D. GET /ims/oneroster/gradebook/v1p2/assessmentResults
      ?filter=metadata.appName='Math Academy' AND scoreDate>='<today − N days>'&limit=3000&offset=0   # page; collect student.sourcedId
      # quiet = roster − active set
E. for each quiet student: GET .../assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy'&sort=scoreDate&orderBy=desc&limit=1
      # their last Math Academy result ever, or none
```

- D is one paged read for the whole estate; it replaces per-student loops. Aggregate labels: numerator = roster students with no Math Academy result in the window; denominator = active in-window enrollments across all sections of the course; basis = OneRoster enrollments, test users excluded (say so).
- Distinguish in the output: never any result at all; enrolled after the window began; stopped, with the last date.
- Failure mode: taking one section as "the course"; taking the roster from the students route (trap 20); counting `active` enrollments whose `endDate` has passed; forgetting that "no result" is a claim about the results container only.

Output shape: one row per quiet student — `user.sourcedId`, `class.sourcedId` (section), `course.sourcedId`, `enrollment.beginDate`, `lastMathAcademyResultEver (date or null)`, `pct (from that result, or absent)`. No email, no name (dictionary § Students are children).

VERIFIED RUN (build 2026-09-16; two cold runs 2026-09-17): A–E executed across every section of a course; the cold runs produced the table above including sections with no active enrollment and students with no result ever.

### 5 · Who finished — "Who has completed their Math Academy course?"

```
A. roster of the course as in ex. 4 (A–C), test users flagged
B. GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<today − 60 days>'&limit=3000&offset=0   # page
      # per roster student: newest result with a pctCompleteApp; finished = that percent is 100
C. GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>'&limit=3000
      # a Math Academy seat that began after the 100 was reached? same course again (re-enrolled, not advanced)? no Math Academy seat at all (moved to a non-Math Academy class)?
```

- Read the 100 from results, not from enrollments: the enrollment's percent is missing on most seats (trap 3).
- A finished seat with no newer Math Academy seat is the case the platform's progression should have handled; report it with the seat id, never as a student's fault. A newer seat in the same course is "re-enrolled, not advanced". A student whose only newer seats are non-Math Academy math classes has left Math Academy.
- One Timeback-side tell for "finished on Math Academy but still parked": a 100 percent seat whose recent events are all reviews, no lessons (trap 10).
- Failure mode: using `metrics.totalXp` as "finished"; reading enrollment `pctCompleteApp` alone.

Output shape: `user.sourcedId`, `course.sourcedId`, `reached100On (scoreDate)`, `disposition: not moved | advanced to <course.sourcedId> | re-enrolled same course | left Math Academy`.

VERIFIED RUN (build 2026-09-16; cold run 2026-09-17): over one course the enrollment-based reading found nobody while the results-based reading found finished students in each disposition above; hence this form.

### 6 · Where a student is struggling — "Which topics is he failing, and did he recover?"

```
GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy' AND scoreDate>='<date>'&limit=3000
      # failed = metadata.xp < 0, or score < 60 (null = 0), or attempt > 1
      # group lesson/review/multistep by topicId (from the URL); group quizzes by line-item title (trap 25)
      # recovered = a passed lesson or review on the same topic after the failed one
```

- Negative XP is any failed task, not only reviews. `score` null is zero correct (trap 9).
- Aggregate labels: per topic, failed attempts over attempts, this student, this window; separate lessons from reviews (a failed review of an earlier course's topic is spaced repetition, trap 8), and quizzes from both.
- Failure mode: grouping quizzes by the id in the URL; treating review failures on an earlier course's topic as a gap in the current course.

Output shape: one row per topic — `topicId (or quiz title)`, `title`, `attempts`, `failed`, `byType {lesson, review, quiz, multistep}`, `lastType`, `lastScoreDate`, `recovered (bool)`.

VERIFIED RUN (build 2026-09-16; two cold runs 2026-09-17): executed for students with 100+ tasks in the window; the cold runs found failures clustered by topic family and most failed topics re-taught and passed within days.

### 7 · Suspect course — "Is anyone in the wrong course?"

The filed course is a Timeback enrollment's course, not Math Academy's (dictionary load-bearing rules, second bullet; trap 10). Timeback alone can only infer a disagreement from what the student is being taught.

```
A. Build the topic map (once per run, estate-wide):
   GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<today − 14 days>'&limit=3000&offset=0   # page
      # keep rows whose URL type is lesson | multistep (never review: earlier courses; never quiz: no topic id)
      # filed course per row = its line item's course.sourcedId (list line items per course: assessmentLineItems?filter=course.sourcedId='…' AND dateLastModified>='<since>')
      # skip isTestUser students; for each topicId count distinct students per FILED course id; keep topics with >= 5 students and top course share >= 0.8
B. Per student on the roster (ex. 4 A–C), over their lesson/multistep topics that are in the map: share whose mapped course id != their current enrollment's course id
      # flag when share >= 0.8 and at least 3 mapped topics; report the course id the topics point at
C. Buckets every student lands in exactly one of: flagged; checked-clear; active but uncheckable (< 3 mapped topics); active with no current Math Academy enrollment (cannot be checked, report as its own finding); quiet (no events in the window)
```

- This is a **heuristic**. Its known false alarms are students in a grade-N class whose lesson topics map to grade N−1 or N+1, because adjacent Math Academy courses share topics; report "suspect: topics point at <course id>", never "wrong". Two cold runs found flags that were in fact Timeback records with a deleted seat still receiving events (trap 21), so a flag is worth reading against the student's timeline (ex. 9) before dismissing it.
- The map is dense for grade-level courses and thin for high-school courses, so high-school students are often uncheckable; say so rather than reporting them clear.
- The pre-built map in `reference/topic-course-map.json` is a dated snapshot of step A keyed by course id; regenerate it rather than trust it. Step A costs a paged estate-wide read plus one per-course line-item listing and one user read per active student; budget for it.
- Aggregate labels: flagged over checkable, with the uncheckable, unenrolled and quiet counts beside it, roster basis stated.

Output shape: one row per roster student — `user.sourcedId`, `bucket`, `enrolledCourseSourcedId`, `topicsPointAtCourseSourcedId (flagged only)`, `share`, `mappedTopics`, `lastEvent`.

VERIFIED RUN (build 2026-09-16; three cold runs 2026-09-17): A–C executed estate-wide and over two courses; the flag set was compared with a Math Academy-side truth list during the build to state the false-alarm profile above, and the cold runs added the uncheckable and unenrolled buckets.

### 8 · Estate-wide day — "How much Math Academy happened yesterday?"

```
A. GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<day>T00:00:00Z' AND scoreDate<='<day>T23:59:59Z'&limit=3000&offset=0   # page
B. for each Math Academy course id (reference/timeback-math-academy-courses.json):
   GET /ims/oneroster/gradebook/v1p2/assessmentLineItems?filter=course.sourcedId='<courseId>' AND dateLastModified>='<day − 7 days>'&limit=3000&offset=0   # page
      # course = the LINE ITEM's course.sourcedId for each result id in A (trap 21); results whose line item is not found are 'unattributed' (ingestion lag, invariant 4)
      # group by course; sum metadata.xp; count by URL type; count distinct students
```

- Attribute by line item, never by the student's current enrollment: a noticeable share of a day's events sit under deleted seats or belong to students with no current seat, and an enrollment join misplaces or drops them. Line items filtered by date alone are far too many to page (trap 19); the per-course listing is the workable path, and fetching each result's line item one by one is the fallback.
- Aggregate labels: events, students, XP by filed course; basis = every Caliper result with `appName` Math Academy in the UTC day, test users excluded or not (say which).
- Failure mode: taking one page as the day (trap 18); mixing UTC and campus days (trap 17); attributing by enrollment (trap 21); windowing line items on `dateLastModified` too tightly and losing late-ingested rows.

Output shape: one row per filed course — `course.sourcedId`, `course.name`, `students`, `events`, `xp`, `lessons`, `reviews`, `quizzes`, `multisteps`, `placements`, `exams`, `supplementals`; plus an `unattributed` row.

VERIFIED RUN (build 2026-09-16; two cold runs 2026-09-17): the cold runs produced the by-course table from line items and showed the enrollment-based join disagreeing on a meaningful share of rows, which is why B is the recipe.

### 9 · Student timeline — "Tell me this student's whole Math Academy story."

```
A. GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>'&limit=3000
      # keep course.name starting 'Math Academy' → every seat ever, with status, beginDate, endDate, course.sourcedId
B. GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy'&sort=scoreDate&orderBy=asc&limit=3000&offset=0   # page, all time
C. GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<id> for each distinct line item in B   # filed course per event (cache; or list per course from A)
      # assemble: per seat — first/last event under it, events count, signed XP sum, highest pctCompleteApp seen, placements; events filed under a seat that is tobedeleted; events filed under a course with no seat at all; gaps between seats; where the percent reached 100 and what began after
```

- Read this before trusting any single "current course" answer: a student's events are routinely filed under a deleted seat while a new seat sits empty (trap 21), and "finished" lives on the results, not the seat (trap 3).
- XP earned per seat is the signed sum of result `xp` under that seat's course; never the enrollment's `metrics.totalXp`.
- Aggregate labels: per seat, events and XP from results filed under that course; time from weekly facts is optional and a floor.
- Failure mode: assuming one seat per course; reading `primary`; using enrollment metrics as totals.

Output shape: one row per seat, ordered by first event — `course.sourcedId`, `course.name`, `status`, `beginDate`, `endDate`, `firstEvent`, `lastEvent`, `events`, `xpSigned`, `maxPct`, `placements`, `eventsWhileSeatDeleted`; plus rows for `course with events but no seat`; plus `gapsDays` between seats.

VERIFIED RUN (cold run 2026-09-17): a fresh agent assembled this from A–C for a student with two seats and a gap, and every derived figure reconciled with EduBridge's daily cells.

### 10 · Math Academy's own figures — "What is her exact XP remaining, and is Timeback's course the right one?"

```
# the same Timeback token you use for every other call; the store replays it against Timeback and serves only students it can read
GET <front base>/store                                        # snapshotAt, snapshotAgeHours, stale, staleAfterDays, history, counts, byCourse, calls  (no token; no student values)
GET <front base>/store/course/<course.sourcedId>              # that course's roster at snapshot time counted by courseAgreement, test users and not-started separately (no token; counts only)
GET <front base>/store/student?email=<student email>          # Authorization: Bearer <your Timeback token>
GET <front base>/store/student/<user.sourcedId>               # same, when you already hold the id (preferred; the email does not travel)
```

- **Freshness rule.** Read `snapshotAt`, `snapshotAgeHours` and `stale` first. The store refreshes nightly (03:00 America/Chicago); `history` on `/store` lists every snapshot ever loaded, so a gap is visible. While `stale` is false (within `staleAfterDays`, two days as served), quote `xpRemaining`, `progress`, `grade` and `currentCourse` as "as of <snapshotAt>". Once `stale` is true (a night was missed), still quote them only with their date, take progress from the newest result instead (ex. 3), and treat `courseAgreement` as indicative: the Timeback half is live, the Math Academy half is old. `figuresAsOf` on a row is `snapshotAt` for rows Math Academy answered directly (`lookup`, `live-lookup`) and "up to one day before" for rows taken from Math Academy's bulk list. A stuck refresh is a ticket on the feedback wire.
- **A student missing from the store** is looked up live once when first asked for (the response says so under `matchedBy: "live-lookup"`), then carried by every later night. A student Math Academy does not know under this organisation's key stays `inSnapshot: false` with the HTTP reason and is retried after 24 hours.
- **Cohort questions** go to `/store/course/{courseSourcedId}` (counts by `courseAgreement`, `testUsers`, `maNotStarted`, one call, no token). Per-student rows cost about one second each (two Timeback calls replayed), so a course of a few hundred students is minutes, not seconds; say so before looping.
- `mathAcademy.currentCourse.name` is the course Math Academy actually runs the student in; `courseAgreement` compares it with the student's live Timeback seats: `agree`, `disagree` (a roster defect: the student's events are being filed under the wrong Timeback course, trap 10; report the Timeback course id and the Math Academy course name), `disagree, math academy course completed` (Timeback moved the student on, Math Academy has not: ask for the Math Academy course change, not a Timeback fix), `no current timeback seat`, `math academy has no current course`, `no math academy record` (see `unmatchedReason`), `not in snapshot`.
- `xpRemaining` is exact and replaces the estimate of ex. 3 for the snapshot date; where you show both, label the estimate's bias. `estimatedScore` appears on SAT Math Prep instead of progress.
- `matchedBy: "name"` (`matchConfidence: "low"`) is a name-only match; say so, or confirm through the student's Timeback `userProfiles` username before acting on it. `lookup` means Math Academy answered a per-student call keyed on the student's Timeback email; `username` means the Timeback `userProfiles` login equalled a bulk-list username.
- `mathAcademyState: "not started"` (progress 0 and `xpRemaining` 0, not completed) means Math Academy has assigned the course and the student has done no task: neither zero is a measurement, and the student also has no Math Academy result in Timeback. Report it as "never started", not as "0 XP left".
- Two current seats: `courseAgreement` is `agree` if Math Academy's course matches **any** current seat; the seats are all listed, so report both.
- `inSnapshot: false` is not "no Math Academy account": read `unmatchedReason` (HTTP 404 = no account under our key; HTTP 401 = under another organisation's key; `no email`) or, without a reason, the student was not on the Timeback roster at `rosterReadAt`. Unmatched rows still carry `isTestUser` and `seatsAtSnapshot`. The route never calls Math Academy on a miss; a fresher or missing record needs the one-off call in § One-off exact figures with a Math Academy key.
- Errors: no token → 401 with the instruction; a token Timeback rejects → 401 with `timebackStatus` 401; an id Timeback does not know → 404 with `timebackStatus` 404 (authentication is checked first, so an unauthenticated caller learns nothing about which ids exist); an email matching no or several Timeback users → 404 with `timebackMatches`; no id and no email → 400.
- PII: `mathAcademy.username`, `firstName`, `lastName` are a child's identifiers; they stay in your session (dictionary § Students are children).
- Failure mode: quoting `xpRemaining` without its date; treating `disagree` on a `name`-matched row as certain; reading `not in snapshot` as "never on Math Academy"; reading a `not started` 0 as "finished".

Output shape: `user.sourcedId`, `snapshotAt`, `figuresAsOf`, `stale`, `matchedBy`, `matchConfidence`, `mathAcademyState`, `maCourse (name)`, `maCourseStart`, `progress (0–1)`, `xpRemaining`, `grade`, `letterGrade`, `estimatedScore (SAT Math Prep only)`, `completed`, `deactivated`, `timebackCourseSourcedId(s)`, `courseAgreement`.

VERIFIED RUN (build 2026-09-17; cold run 2026-09-17 evening): the calls executed against the live store under a read-only Timeback client; a cold agent read every non-test student of one course through the route in about a second each and reconciled the counts with `/store/course`; a token-less call, a forged token, an unknown id and a bad email returned the statuses above; an Algebra I student's exact figure sat about a quarter above the estimate.

### 11 · Engaged versus productive time, and the course history — "Was he really working? When did she change course?"

```
GET <front base>/store/student/<sid>/activity?from=<YYYY-MM-DD>&to=<YYYY-MM-DD>     # Authorization: Bearer <your Timeback token>
      # tasks[]: Math Academy's own record per task with timeElapsedMs / timeEngagedMs / timeProductiveMs, type, xpAwarded, course, topic, taskId
      # days[]: Math Academy's day totals in seconds; activityLastDate = newest day the store has pulled
GET <front base>/store/student/<sid>/history                                          # one row per nightly snapshot: courseId, progress, xpRemaining, completed, grade, state, agreement
GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy' AND scoreDate>='<from>'&limit=3000
      # optional: Timeback's row for the same tasks; join on taskId == /tasks/<taskId>/ in metadata.originalObjectId
```

- **Days are pulled, not computed.** The store pulls a day for a student only if they had a Math Academy result in Timeback on that America/Chicago day, the night after. A day absent from `days[]` was not pulled: before the store began, or no Timeback result that day, or last night's run has not reached it yet (`activityLastDate`). Never read absence as zero minutes.
- **The three clocks.** `timeElapsed` is wall time on the task (the only clock Timeback receives, as `activeSeconds`); `timeEngaged` is the part Math Academy judged attentive; `timeProductive` is the part that advanced the task. Report the ratios per day, not per task: a single review is seconds long. Aggregate labels: numerator and denominator in seconds, basis = tasks Math Academy recorded on the pulled days.
- **Course history.** `history[]` starts the night the store began; a change of `courseId` between two nights is a course change and the last row of the old course carries `completed`. For anything older, use Timeback's results (ex. 9), which hold the Caliper half of the story back to the oldest reachable result.
- PII: none in these two responses beyond `user.sourcedId`; the join to Timeback rows is by task id.
- Failure mode: treating a day with no `days[]` row as a day of zero work; comparing `timeElapsedMs` (milliseconds) with `days[].timeElapsedSec` (seconds) without converting; reading `history` as Math Academy's full past when it starts at the store's first night.

Output shape: per day — `date`, `tasks`, `elapsedMin`, `engagedMin`, `productiveMin`, `engagedShare`, `productiveShare`, `xpAwarded`; per course change — `fromCourseId`, `toCourseId`, `firstNightSeen`, `oldCourseCompleted (date or null)`.

VERIFIED RUN (build 2026-09-17 evening): the activity pull ran for the previous local day and the route returned tasks with the three clocks for an active student; history returned one row per night loaded so far.

### 12 · The knowledge map — "What does this student actually know?"

```
GET <front base>/store/student/<sid>/knowledge                 # Authorization: Bearer <your Timeback token>; current course; cached 7 days
GET <front base>/store/student/<sid>/knowledge?courseId=<mathAcademyCourseId>&refresh=1   # another course of theirs, or force one live call
```

- The first ask makes **one live Math Academy call** and caches the map for seven days (`fetchedAt`, `fromCache`); later asks are free. This is the one place a reader's request reaches Math Academy through the skill, so ask per student when a person needs it and **never loop it over a roster** (Math Academy's fair-use limit answers 429; the store passes the failure through as 502 with `mathAcademyStatus`).
- `knowledge.courses[]` is the course asked for plus up to two prerequisite courses. Walk `units[] → modules[] → topics[]`; `stability` (0–1) is Math Academy's estimate of long-term retention, averaged upward to module and unit; `completion` (0–1) per course. Read low stability on a completed topic as "fading", a topic absent from every course as "never taught here".
- Pair it with ex. 6 (failed tasks by topic from Timeback): the map says what is held, the results say what was struggled with; the topic ids are the same numbers.
- PII: none beyond `user.sourcedId`; topic names are curriculum, not the child.
- Failure mode: looping the call; reading `stability` as a score on a test; quoting the map without `fetchedAt`.

Output shape: per course — `courseId`, `name`, `completion`; per unit — `name`, `stability`, `weakestTopics[] {topicId, name, stability}` (lowest first); a headline `topicsBelow(0.5)` count with its denominator.

VERIFIED RUN (build 2026-09-17 evening): one live call returned the requested course plus prerequisite courses with unit, module and topic stability; the second call for the same student came from cache.

## Cross-system notes

- The Math Academy task id and topic id inside the task URL are this source's only handles into Math Academy. They are claims; matching them to Math Academy's records is the caller's, over both systems.
- Timeback never receives Math Academy's exact XP remaining, estimated SAT score, course grade, engaged/productive split, or per-topic knowledge map. A question that needs them routes to the Math Academy API.
- Waste and integrity signals for Math Academy sessions live in timeback_analytics' capture estate, not here (trap 4).

### One-off exact figures from Math Academy (outside this skill's wire)

When a reader needs the exact figure this skill can only estimate, one direct call to Math Academy answers it. This is a documented fallback for a single student on demand, not a data path of this skill: do not poll it, do not loop it over a roster, and never store its key in anything this skill serves. It needs a **Math Academy public API key** for the organisation the student belongs to (issued by Math Academy to the school; one per organisation; a student under another organisation's key answers 401 "Not Authorized", which is a key limit, not an absence). The current API version is `beta10` (`beta9` still answers); its fair-use limit answers `429` with a `Retry-After` header.

```
GET https://mathacademy.com/api/beta10/students/<student email, Math Academy id or username>
    Public-API-Key: <the organisation's key>
    # -> student.currentCourse: { id, name, startDate, progress (0-1), xpRemaining, completed, grade, letterGrade, estimatedScore }
    #    estimatedScore appears instead of progress on SAT Math Prep; xpRemaining is the exact figure this skill estimates
GET https://mathacademy.com/api/beta10/students/<id>/activity?startDate=<YYYY-MM-DD>&endDate=<YYYY-MM-DD>
    # -> activity.tasks[]: { id, type (Lesson|Review|Quiz|Multistep|Placement|Exam|Supplemental), xp, xpAwarded, questions, questionsCorrect,
    #    started, completed (epoch ms), course{id,name}, topic{id,name}, analysis{timeElapsed,timeEngaged,timeProductive} }; activity.totals
GET https://mathacademy.com/api/beta10/students/<id>/courses/<mathAcademyCourseId>/knowledge
    # -> courses[] (the course asked for plus up to two prerequisite courses): { id, name, completion (0-1),
    #    units[] { id, name, stability, modules[] { id, name, stability, topics[] { id, name, stability (0-1, long-term retention) } } } }
```

- The email Math Academy knows is the login username on the student's Timeback `userProfiles` entry (vendorId `math_academy`); it is usually the Timeback email but not always, and the per-student call accepts the username too.
- Reconcile before trusting: the task ids in `activity.tasks[].id` are the same numbers as `/tasks/<taskId>/` in this skill's result URLs, so a one-off pull can be checked against Timeback's rows for the same days.
- What this fallback gives that Timeback cannot: `xpRemaining` exact, `estimatedScore` on SAT Math Prep, `letterGrade`, task `type` as a field, engaged versus productive time, and the per-topic knowledge map.
- Math Academy's API has changed without notice before (a version retired, progress replaced by a score on one course); read the response shape, do not assume it.

## Improvement loop

File feedback on this skill's own wire, published in the `/skill` front under `feedback`: `POST <feedback.report>` with JSON `{title, body, reporter, kind?}` files a public, attributed ticket on this skill's own tracker and returns its number and URL; every ticket is mirrored daily into a GitHub issue on the repo named in the front (labels `skill-feedback` + `mathacademy_timeback`) and closures there are copied back. `GET <feedback.open>` lists the open items and `?state=closed|all` the rest; `GET <feedback.open>/{number}` shows one ticket with its thread. Titles are capped at 200 characters and bodies at 10,000. A report shaped `From: / Problem (dated evidence): / Ask: / Acceptance (a falsifiable test the fix must pass):` graduates straight into an eval case. Evidence in a ticket is a class, a field, a rule, or the query that measures it; never a student's name, contact, or an identifying row, and never a figure read off the wire. A question this pair cannot answer, or a report unacted on, is this skill failing its contract; say so.

Standing open items, each a ticket on this wire: **#7** (which course ids progression honours), **#8** (Math Academy student id in Timeback), **#9** (null scores), **#10** (retention), **#11** (duplicate time rows).
