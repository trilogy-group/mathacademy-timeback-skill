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
- **Timezone: America/Chicago unless told otherwise.** The estate is Alpha (Texas); nothing served carries a student's zone, and the store fixes its day to America/Chicago. A local day is the UTC window from local midnight to local midnight (CDT is UTC−5, CST is UTC−6): bound `scoreDate` with both ends of that window as UTC instants, pass the same instants to EduBridge with `timezone=America/Chicago`, and take the window from `/store` `lastActivityRun.windowUtc` or `days[].windowUtc` when the store has pulled that day. Say which zone you used. "Today" in a recipe means the day asked about.
- **Timeback's minutes are engaged minutes.** `activeSeconds` is Math Academy's engaged clock (the part of a task the student was attentive), not wall time; label it "engaged minutes on tasks that sent a time row". Elapsed and productive time live only in the store (ex. 11).
- **Paged reads sort by `scoreDate`.** Ingestion continues while you page; pass `sort=scoreDate&orderBy=asc` on every estate-wide read (trap 18).
- **Test users:** the flag is not filterable on the users list; read it per class from `classes/{id}/students`, per row from the store's course student list, or per user from `users/{id}` (trap 12).
- **Loops that are free and loops that are not.** The store's `/activity`, `/history` and course routes never reach Math Academy and may be looped over a cohort; the per-student row makes one Math Academy call only when the student is missing; the knowledge route makes one per student per course id per week. A cohort with figures is one call on `/store/course/{id}/students`.
- **A permission error is a key limit, not an absence.** 401 means mint again; 403 means the credential does not cover the route; report either, never estimate past it.
- **The store is dated.** Math Academy's own figures (true course, exact XP remaining, grade, SAT estimate) come from this skill's snapshot store (ex. 10), read with the same Timeback token; print `snapshotAt` beside every figure from it, and use Timeback's live containers for anything about today.

## Capabilities — what you can answer here

Each is buildable by a cold agent with `GET /skill`, this pair, and a Timeback credential. This list is the claim surface.

1. **A student's Math Academy task history** — every task with type, topic, XP, accuracy and (where a time row exists) time, in a window.
2. **A student's daily and weekly Math Academy totals** — XP, questions, correct, active minutes per day.
3. **A student's current Math Academy course and how far through it they are** — course, completion percent and its age, and an estimated XP remaining with its basis and its known bias named.
4. **Who has gone quiet** — students in a Math Academy course (all its sections) with no Math Academy event in N days.
5. **Who has finished their course** — first 100 in the window by filed course, confirmed by the store's completion date, and whether they have since been moved (results-first: progression deletes the finished seat).
6. **Where a student is struggling** — failed tasks and low accuracy by topic, and whether a failed topic was re-taught and passed.
7. **Whether a student's Timeback course looks wrong, from Timeback alone** — a weak suspect-course heuristic from lesson topic ids (precision about 1 in 8 against the store), for when the store is stale or silent; capability 10 answers the question definitively.
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
| "What course is she in and how far along?" | the store row first (`/store/student/{sourcedId}`: Math Academy's course, progress, exact XP remaining, dated); Timeback's newest result filed under the seat's course for today's percent; the estimate only as a labelled fallback (ex. 3, ex. 10) |
| "Who is active in this course this week?" | roster (ex. 4 A–C) ∩ one estate-wide results read for the window (ex. 4 D); never one results read per student |
| "Who in this course hasn't touched Math Academy in two weeks?" | every section by `course.sourcedId` → active in-window enrollments → estate-wide results since day D → roster minus active set; then the store's course student list for their Math Academy state (ex. 4) |
| "Who finished?" | estate-wide results at 100 in the window → line items → filed course → all enrollments → disposition; the store's `completed` confirms (ex. 5). Never roster-first: progression deletes the finished seat |
| "Where is he struggling, and did he recover?" | results by student, not-credited tasks by topic, latest-attempt recovery rule (ex. 6) |
| "Is anyone in the wrong course?" (cohort) | the store: `/store/course/{id}` counts, then `…/students?agreement=disagree` for the rows (ex. 10); definitive, four calls. The Timeback-only heuristic (ex. 7) only when the store is stale or the student has no row |
| "How much Math Academy happened yesterday across the school?" | estate-wide results with `metadata.appName` and `scoreDate` bounds, course from line items via per-course line-item listing (ex. 8) |
| "Tell me this student's whole Math Academy story." | all-time results + all Math Academy enrollments + line items → timeline (ex. 9) |
| "What is her EXACT XP remaining / true course / SAT score / grade?" | the store: `GET <front base>/store/student/{sourcedId}` with your Timeback token (resolve an email to an id once, first); dated as of `figuresAsOf` (ex. 10) |
| "Is Timeback's course for this student the one Math Academy runs?" | the store's `courseAgreement` (ex. 10): definitive as of the snapshot, unlike the topic heuristic of ex. 7 |
| "Was he actually paying attention? How much of the time was productive?" | the store's `…/activity?from=&to=` (ex. 11): Math Academy's elapsed / engaged / productive per task, joined to Timeback's rows by task id |
| "How focused was my class yesterday?" | roster (ex. 4 A–C) → `/store/course/{id}/activity?date=` (one call; per-student day totals), or `/activity` per active student (ex. 11) |
| "When did she change course on Math Academy, and when did she finish the old one?" | the store's `…/history` (ex. 11) for nights since the store began; ex. 9 (Timeback results) for anything earlier |
| "What does this student actually know? Where is she weak?" | the store's `…/knowledge` (ex. 12): one live call on first ask, cached 7 days; never loop it over a roster |
| "I need it fresher than last night" | one direct Math Academy call with the organisation's Math Academy key (§ One-off exact figures), never a loop |

## Worked examples

Every call is a direct native request against the base URL with the bearer header. Filters are plain query-string parameters, URL-encoded whole. Dates in filters are ISO; `scoreDate` compares as a timestamp, so `>= '2026-09-01'` means midnight UTC. For an America/Chicago window write both bounds as UTC instants of local midnight (`2026-09-16T05:00:00Z` to `2026-09-17T04:59:59Z` for the Chicago day 2026-09-16 in CDT). Reading cost: the estate produces on the order of two thousand Math Academy results a day; a week is a few pages of 3000.

### 1 · Task history — "What did this student do on Math Academy this week?"

```
# start from the student's Timeback id (user.sourcedId). Only if a person handed you an email, resolve it ONCE and carry the id from then on:
GET /ims/oneroster/rostering/v1p2/users/?filter=email='<student email>'          # → users[0].sourcedId ; the email does not travel further
GET /ims/oneroster/gradebook/v1p2/assessmentResults
      ?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy' AND scoreDate>='<YYYY-MM-DD>'
      &sort=scoreDate&orderBy=desc&limit=3000&offset=0                            # page until offset >= totalCount
GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<assessmentLineItem.sourcedId>   # title = topic name, course = filed course (one per row; cache)
```

- Parse `metadata.originalObjectId`: `/topics/<topicId>/<type>` for lesson, review, quiz, multistep; `/tasks/<taskId>/<type>` (no topic) for placement, exam, supplemental. Only lesson and review slots are topic ids; quiz and multistep slots are instance ids (trap 25).
- Read `metadata.xp` (signed XP awarded; `<= 0` = not credited by Math Academy, ticket 20), `score` (null = zero correct), `metadata.totalQuestions`, `metadata.correctQuestions`, `scoreDate` (UTC completion time), `metadata.pctCompleteApp` (may be absent).
- For seconds per task, read the student's weekly facts (ex. 2, step B) and join `TimeSpentEvent` rows on `datetime` = `scoreDate` (or on `source`, the Caliper event id, which cannot collide); some tasks have no time row (invariant 1). Never join on `activityName` (trap 26). Those seconds are Math Academy's **engaged** clock, not wall time.
- The line item costs one GET per task; for a long window list them per course instead (`assessmentLineItems?filter=course.sourcedId='…' AND dateLastModified>='<from − 7 days>'`) or take topic names from the store's knowledge map (ex. 12).
- Failure mode: treating `dateLastModified` as the activity time (it is ingestion time, sometimes days late); reading `review` rows as new lessons; reading a null score as missing.

Output shape: one row per task — `scoreDate (UTC)`, `localDay`, `type`, `topicId (null for placement/exam/supplemental; instance id for quiz/multistep)`, `title`, `filedCourseSourcedId`, `xpAwarded (int, signed)`, `score (0–100, null = 0 correct)`, `correct/total`, `pctCompleteApp (string % or absent)`, `engagedSeconds (or null)`.

VERIFIED RUN (build 2026-09-16; four cold runs 2026-09-17): the calls executed and returned the shape above; the cold runs met every URL type including exam and supplemental, negative XP on lessons, and tasks without a time row.

### 2 · Daily totals — "How many minutes and XP per day?"

```
A. GET /edubridge/analytics/activity?studentId=<sid>&startDate=<first local day>T05:00:00Z&endDate=<day after last local day>T04:59:59Z&timezone=America/Chicago
      # bounds are UTC INSTANTS and day labels are LOCAL: pass local midnight as UTC (05:00Z in CDT, 06:00Z in CST) or a partial extra day appears; date-only bounds are a 422
      # factsByApp[<day>].Math["Math Academy"].activityMetrics / timeSpentMetrics  — the Math Academy cell; facts[<day>].Math mixes apps (trap 23); drop days outside the range you asked for
B. GET /edubridge/analytics/facts/weekly?studentId=<sid>&weekDate=<any date in the week>&timezone=<same zone>
      # {message, startDate, endDate, facts[]}: EVERY app's rows for the week (thousands; no server-side app filter); keep app == 'Math Academy';
      # eventType 'ActivityEvent' for XP/questions, 'TimeSpentEvent' for activeSeconds; datetime = scoreDate; date = the local day; userId = user.sourcedId
```

- A gives the day rollup; B gives the events behind it. B has one ActivityEvent row per task and a TimeSpentEvent row for most (traps 5, 26); `activeSeconds` is a string. Days with no activity are absent from A, not zero.
- **These minutes are engaged minutes.** `activeSeconds` is Math Academy's engaged clock (dictionary § EduBridge field meanings); a guide asking "how long was she on Math Academy" gets attentive time here and wall time only from the store (ex. 11).
- `wasteSeconds` is always 0 for Math Academy (trap 4): do not report it as clean behaviour.
- Aggregate labels: XP = sum of `ActivityEvent.xpEarned`; engaged minutes = sum of `TimeSpentEvent.activeSeconds` / 60, a floor (tasks without a time row are missing from it); basis = this student's Math Academy rows in the requested window and zone.
- Failure mode: omitting `timezone` and getting UTC days without saying so; passing `T00:00:00Z` bounds with a non-UTC zone and summing the spilled previous evening; summing all fact rows and doubling the event count; reading `facts[day].Math` as Math Academy alone when Math Raiders contributed; calling engaged minutes "time on Math Academy".

Output shape: one row per active day — `date (local)`, `xpEarned`, `correct/total`, `masteredUnits`, `engagedMinutes (floor)`, `apps[]` for the Math cell.

VERIFIED RUN (build 2026-09-16; cold runs 2026-09-17): A and B executed; daily XP, questions, correct and mastered units equalled the summed result rows on every day checked; minutes matched the time rows to the second where a time row existed.

### 3 · Current course and progress — "What course is she in and how far along?"

```
1. GET <front base>/store/student/<sid>[?minimal=1]   (Authorization: Bearer <your token>)   # FIRST: Math Academy's own course, progress (0–1), exact xpRemaining, grade, completion, courseAgreement, all dated (ex. 10)
2. GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>' AND status='active'&limit=3000
      # keep rows whose course.name starts 'Math Academy' and whose beginDate..endDate contains today → the current seat(s); report both if two
3. GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy'&sort=scoreDate&orderBy=desc&limit=300
      # newest result whose metadata.pctCompleteApp is present → candidate progress as of today; its scoreDate → the progress's age
      # (a fifth to a third of rows carry no percent, lessons most often; if none of 300 does, fall back to the enrollment's copy and say so)
4. GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<that result's assessmentLineItem.sourcedId>
      # its course.sourcedId MUST equal the seat's course.sourcedId; if not, the percent belongs to another course (see below)
5. GET /ims/oneroster/rostering/v1p2/courses/<course.sourcedId>          # metadata.metrics.totalXp, read live (trap 11) — only for the fallback estimate
```

- Progress is the newest result's `pctCompleteApp` (string) **whose line item is filed under the seat's course**. A student moved between courses routinely has their newest percent filed under the old course (traps 10 and 21): a Prealgebra 100 next to an Algebra I seat is not "Algebra I complete", it is "the events are still landing under Prealgebra". In that case report `estRemaining.basis = "none: newest percent belongs to <line item course.sourcedId>"` and flag the seat; the store's `courseAgreement` (ex. 10) says whether Math Academy agrees with the seat. The enrollment's `metadata.pctCompleteApp` is a convenience that is often absent (trap 3); use it only when no percent-bearing result exists for the seat's course, and say so. The percent's age is the result's `scoreDate`.
- **XP remaining: the store's `xpRemaining` is the answer** (exact, dated by `figuresAsOf`, served on SAT Math Prep too). The Timeback-only estimate `course.metadata.metrics.totalXp × (1 − pct/100)`, basis "timeback course XP", per `reference/course-xp-size.json`, is a fallback for a student the store does not hold or when `stale` is true, and it is **not a number to publish**: against the exact figure it ran from 15 percent too high to 64 percent too low across the students checked (denominator: the exact figure; usually low, because Math Academy awards extra XP on failed reviews). Serve it only as "a lot / a little / nearly done" with that band named. No estimate when the percent belongs to another course, the course carries no `totalXp`, no percent exists yet, or the course is SAT Math Prep (progress is null there; the store still has the exact figure).
- Do not report the enrollment's `metrics.totalXp` as XP earned: it is a course-size snapshot or an unexplained figure, not a running total (dictionary § enrollment). XP earned under a seat is the signed sum of result `xp` for that seat (ex. 9).
- Failure mode: taking the first active enrollment (an old course still `active`); trusting `primary`; dividing anything by course `totalXp` to get progress.

Output shape: per current seat — `course.sourcedId`, `course.name`, `enrollment.beginDate`, `store {mathAcademyCourse, progress, xpRemaining, grade, letterGrade, estimatedScore, completed, courseAgreement, figuresAsOf, stale}`, `pctToday (from newest result filed under this course)`, `pctAsOf (scoreDate)`, `estRemaining {value | null, basis: "timeback course XP" | "none: newest percent belongs to <course.sourcedId>" | "none: course has no totalXp" | "none: no percent yet" | "none: SAT Math Prep reports a score", biasNote}` (fallback only).

VERIFIED RUN (build 2026-09-16; cold runs 2026-09-17): executed; the newest result's percent matched the enrollment's copy where the copy existed and was present where the copy was missing. Cold runs met the "percent belongs to another course" case on the first student picked (a Prealgebra 100 under an Algebra I seat), which is why the line-item step is mandatory; across six students in five courses the estimate ranged from 15 percent high to 53 percent low against the store's exact figure, which is why the store is step 1.

### 4 · Who has gone quiet — "Who in this course hasn't touched Math Academy in two weeks?"

```
A. GET /ims/oneroster/rostering/v1p2/classes/?filter=course.sourcedId='<courseId>'&limit=3000      # every section (trap 1)
B. for each class: GET /ims/oneroster/rostering/v1p2/enrollments/?filter=class.sourcedId='<classId>' AND status='active'&limit=3000
      # keep role = 'student' and the day asked about inside beginDate..endDate → the roster (user.sourcedId); this, not the students route, is the roster (trap 20)
C. for each class: GET /ims/oneroster/rostering/v1p2/classes/<classId>/students?limit=3000
      # key is `users`; use ONLY to resolve roster ids to metadata.isTestUser (it also returns users whose enrollment is deleted; ~2 s per section)
      # cheaper: GET <front base>/store/course/<courseId>/students (token) carries isTestUser per roster row in one call
D. GET /ims/oneroster/gradebook/v1p2/assessmentResults
      ?filter=metadata.appName='Math Academy' AND scoreDate>='<UTC instant of local midnight, today − N days>'&sort=scoreDate&orderBy=asc&limit=3000&offset=0   # page; collect student.sourcedId
      # quiet = roster − active set
E. for each quiet student: GET .../assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy'&sort=scoreDate&orderBy=desc&limit=1
      # their last Math Academy result ever, or none (its pctCompleteApp may belong to an earlier course: check the line item or use the store)
F. GET <front base>/store/course/<courseId>/students   (token)   # one call: each roster student's Math Academy state, course, progress, agreement
```

- D is one paged read for the whole estate; it replaces per-student loops. Aggregate labels: numerator = roster students with no Math Academy result in the window; denominator = active in-window enrollments across all sections of the course; basis = OneRoster enrollments, test users excluded (say so).
- Distinguish in the output, from E and F together: **never any result at all**; **enrolled after the window began**; **stopped, with the last date**; **finished, not quiet** (last result at 100 or store `completed`/`at 100, not marked complete`: route them to ex. 5); **not started on Math Academy** (store state, so the quiet is by design); **wrong course** (store `disagree`: their events are being filed elsewhere, a roster defect, not disengagement); **no Math Academy record** (store, with the HTTP reason); **Math Academy shows progress but Timeback has no result** (dictionary § range of an absence, fourth case, ticket 23).
- Failure mode: taking one section as "the course"; taking the roster from the students route (trap 20); counting `active` enrollments whose `endDate` has passed; forgetting that "no result" is a claim about the results container only; handing a lead a quiet list with finished and wrong-course students still on it.

Output shape: one row per quiet student — `user.sourcedId`, `class.sourcedId` (section), `course.sourcedId`, `enrollment.beginDate`, `kind (never | new | stopped | finished | not started | wrong course | no record | events elsewhere)`, `lastMathAcademyResultEver (date or null)`, `storeState`, `storeCourseAgreement`. No email, no name (dictionary § Students are children).

VERIFIED RUN (build 2026-09-16; three cold runs 2026-09-17): A–F executed across every section of a course; the cold runs produced the table above including sections with no active enrollment and students with no result ever, and found the finished, wrong-course and events-elsewhere kinds hiding inside a naive quiet list.

### 5 · Who finished — "Who has completed their Math Academy course?"

**Start from results, never from the roster.** Timeback's progression marks the finished seat `tobedeleted` the moment it advances the student, so a finisher is on the finished course's *current* roster only while nothing has happened yet; a roster-first read finds almost nobody and instead surfaces students with a stale 100 from a *previous* course (a cold run: 1 real finisher found, 9 false ones, 87 missed).

```
A. GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<window start>'&sort=scoreDate&orderBy=asc&limit=3000&offset=0   # page the whole estate
      # per student: the FIRST row at pctCompleteApp "100" in the window, and whether a sub-100 row precedes it (else the finish is "on or before" the first row)
B. for each Math Academy course id: GET /ims/oneroster/gradebook/v1p2/assessmentLineItems?filter=course.sourcedId='<courseId>' AND dateLastModified>='<window start − 7 days>'&limit=3000&offset=0
      # the FILED course of that first-100 row; keep the course(s) asked about
C. GET /ims/oneroster/rostering/v1p2/users/<sid>   → metadata.isTestUser (or take the flag from the store's course student list)
D. GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>'&limit=3000   # every seat, any status
      # disposition from the NEWEST-BEGUN current Math Academy seat (active, in window): advanced to <course>; re-seated in the finished course; a newer Math Academy seat exists but is itself tobedeleted (no current seat); no current Math Academy seat, newer non-Math Academy seats exist (titles listed; nothing served says which are "math"); no current seat and no newer seat of any kind
E. GET <front base>/store/student/<sid>   (token)   # confirmation: mathAcademyState `completed` with its date, or `at 100, not marked complete`; courseAgreement; a first read of a seatless student triggers the store's live lookup
```

- **"100" in Timeback is not "finished."** The percent is a rounded integer (a Timeback 100 has been Math Academy's 0.995 with XP left), it can dip back to 99, and Math Academy sets `completed` at the student's **last lesson**, which has been five months after Timeback's first 100 and 35 days after it in cold runs. The store's `completed` (or `progress == 1`) is the confirmation; without it report "at 100 in Timeback, not confirmed complete".
- Once Math Academy has moved the student, the finished course's completion date is gone from the store's main row (it serves only the current course); the store's history keeps it only if a night saw it. So the store confirms mostly the students Math Academy has **not yet moved**: those are the actionable ones (`courseAgreement: disagree, math academy course completed` = Timeback advanced them, Math Academy did not; ask for the Math Academy-side move; whether the Timeback seat is the right next course is open question #7).
- There is no reliable Timeback-side tell for "finished but parked"; the "reviews only after 100" idea failed on every actionable case.
- A finished seat with no newer Math Academy seat and no newer seat at all is the case progression should have handled; report it with dates, never as a student's fault. Finishers from the last two or three days may simply not have been processed yet.
- Failure mode: starting from the roster; reading the newest percent without its line item (9 of 10 false hits); using `metrics.totalXp` as "finished"; dating a finish that was already 100 on the first in-window row.

Output shape: `user.sourcedId`, `finishedCourseSourcedId (filed)`, `reached100On (first 100; flag "on or before" when no sub-100 row precedes it)`, `lessonsAfter100`, `disposition: advanced to <course.sourcedId> | re-seated same course | newer seat already deleted | no current seat, other seats | no current seat, no newer seat`, `store {state, completed, mathAcademyCourse, courseAgreement} | not in store`.

VERIFIED RUN (cold run 2026-09-17 evening): over three courses the results-first form found 88 finishers (64 dated inside the window) where the old roster-first form found one; the store confirmed 33 and was silent on the 47 seatless ones until read; 7 students were advanced in Timeback while Math Academy still ran them in the finished course.

### 6 · Where a student is struggling — "Which topics is he failing, and did he recover?"

```
GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy' AND scoreDate>='<date>'&limit=3000
      # two labels, kept apart: notCredited = metadata.xp <= 0 (Math Academy awarded nothing or took XP away);  lowScore = score < 60 (null = 0)
      # group lesson and review by topicId (from the URL); group quizzes AND multisteps by line-item title (their URL ids are instances, trap 25)
      # per topic: attempts = count of tasks on it (the attempt field is always 1); state = recovered | open | never failed
      #   recovered = the LATEST task on the topic is a credited lesson or review;  open = the latest task is not credited (no retry yet)
```

- **Failure has two readings and Math Academy's own rule is not published** (ticket 20). `xp <= 0` is Math Academy's verdict (it credited nothing); `score < 60` is the reader's. They disagree on about a tenth of tasks: 0-XP reviews at 2 of 5, a −1 lesson at 6 of 9, quizzes and multisteps at 43 to 58 percent with positive XP and `masteredUnits` 1. Report both columns and let the guide see which one they are looking at; never call a quiz or multistep "failed" on score alone.
- `score` null is zero correct (trap 9). A failed review of an earlier course's topic is spaced repetition (trap 8): separate lessons from reviews.
- Quizzes and multisteps cannot be tied to topics from Timeback; their titles are `Quiz N` and problem names. The store's activity rows (ex. 11) carry Math Academy's own `topicId` per task where one exists.
- Titles: one line-item GET per task is the literal path; cheaper are the per-course line-item listing (ex. 8 B) or the topic names inside the knowledge map (ex. 12).
- Aggregate labels: per topic, not-credited over attempts, this student, this window, by type.
- Failure mode: grouping quizzes or multisteps by the id in the URL; treating review failures on an earlier course's topic as a gap in the current course; calling a topic "not recovered" when it was failed today and simply has no retry yet (that is `open`).

Output shape: one row per topic — `topicId (or quiz/multistep title)`, `title`, `attempts`, `notCredited`, `lowScore`, `byType {lesson, review, quiz, multistep}`, `lastType`, `lastScoreDate`, `state (recovered | open | never failed)`, `stability (from ex. 12, lesson/review topics only)`.

VERIFIED RUN (build 2026-09-16; three cold runs 2026-09-17): executed for students with 100+ tasks in the window; the cold runs found failures clustered by topic family, most re-taught and passed within days, the two failure readings disagreeing on about a tenth of rows, and multistep ids absent from the knowledge map.

### 7 · Suspect course — "Is anyone in the wrong course?"

**The definitive answer is the store**: `GET <front base>/store/course/<courseId>` for the counts and `…/students?agreement=disagree` (token) for the rows, four calls for two courses, compared against Math Academy's own course (ex. 10). This Timeback-only heuristic is the fallback when the store is `stale` or a student has no row, and it is weak: against the store on two grade courses it scored precision about 1 in 8 and recall about 1 in 5, because most wrong-course students are quiet or have too few mapped topics, and because a Math Academy course with no Timeback course in your org (8th Grade Math in the main org) can never be pointed at.

```
A. Build the topic map (once per run, estate-wide):
   GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<today − 14 days>'&sort=scoreDate&orderBy=asc&limit=3000&offset=0   # page
      # keep rows whose URL type is lesson ONLY (reviews revisit earlier courses; quiz and multistep slots are instance ids, not topics)
      # filed course per row = its line item's course.sourcedId (list line items per course: assessmentLineItems?filter=course.sourcedId='…' AND dateLastModified>='<today − 21 days>')
      # skip isTestUser students (flag from the store's course student lists, else users/{id}); per topicId count distinct students per FILED course id; keep topics with >= 5 students and top course share >= 0.8
B. Per student on the roster (ex. 4 A–C), over their lesson topics in the map WITH scoreDate >= the current seat's beginDate: share whose mapped course id != the seat's course id
      # flag when share >= 0.8 and at least 3 mapped topics; report the course id the topics point at and the seat's beginDate
      # also report filedElsewhereShare = share of ALL the student's window events whose line-item course != the seat's course (trap 21; incoherent record even when the store says agree)
C. Buckets every student lands in exactly one of: flagged; checked-clear; active but uncheckable (< 3 mapped lesson topics); quiet (no Math Academy event of any type in the window)
   D. The unenrolled: students whose lesson events in the window were FILED under this course while they hold no current seat in it (from A's rows, not the roster): list them as their own finding
```

- Known false alarms: adjacent-grade topic sharing (a grade-N student on grade N−1 lesson topics); a **student moved inside the window** (both systems moved them last week and every event in the window belongs to the old course; the `beginDate` cut in B removes this); deleted seats still receiving events (trap 21; read the timeline, ex. 9).
- The map's range is Timeback's course list; its coverage is dense for grade courses, thin for high school. `reference/topic-course-map.json` is a dated lesson-only snapshot keyed by course id; rebuild it rather than trust it. Measure of the bar: topics mapped against topics dropped by the share rule and topics with too few students, from the map you build.
- Aggregate labels: flagged over checkable, with uncheckable, quiet and unenrolled beside it, and `filedElsewhereShare` distribution; roster basis stated.

Output shape: one row per roster student — `user.sourcedId`, `bucket`, `enrolledCourseSourcedId`, `seatBeginDate`, `topicsPointAtCourseSourcedId (flagged only)`, `share`, `mappedTopics`, `filedElsewhereShare`, `lastEvent`, `storeCourseAgreement (when the store holds them)`.

VERIFIED RUN (build 2026-09-16; four cold runs 2026-09-17): executed estate-wide and over pairs of courses; the last run measured the heuristic against the store's definitive answer (3 true flags, 20 false, 12 missed over two courses), which is why the store is now the recipe and this the fallback.

### 8 · Estate-wide day — "How much Math Academy happened yesterday?"

```
A. GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<day>T05:00:00Z' AND scoreDate<='<day+1>T04:59:59Z'&sort=scoreDate&orderBy=asc&limit=3000&offset=0   # page
      # the America/Chicago day as UTC instants (05:00Z in CDT, 06:00Z in CST); a UTC-day window moves about a tenth of the day's events; the store's lastActivityRun.windowUtc gives the same bounds
B. for each Math Academy course id (reference/timeback-math-academy-courses.json):
   GET /ims/oneroster/gradebook/v1p2/assessmentLineItems?filter=course.sourcedId='<courseId>' AND dateLastModified>='<day − 7 days>'&limit=3000&offset=0   # page
      # course = the LINE ITEM's course.sourcedId for each result id in A (trap 21)
C. for each result whose line item was not in B: GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<assessmentLineItem.sourcedId>   # the fallback; still missing → 'unattributed' (ingestion lag, invariant 4)
D. test users: GET <front base>/store/course/<courseId>/students (token) per course carries isTestUser for every roster student in one call; only students with no seat need GET users/<sid>
      # group by course; sum metadata.xp; count by URL type; count distinct students
```

- Attribute by line item, never by the student's current enrollment: a noticeable share of a day's events sit under deleted seats or belong to students with no current seat, and an enrollment join misplaces or drops them. Line items filtered by date alone are far too many to page (trap 19).
- **When is yesterday complete?** Ingestion lag on a day's rows had a median of minutes but a tail of 9 to 18 hours (invariant 4); read the day at least a day later or say when you pulled. The store's activity pull runs the next morning and re-pulls nothing, so its day totals can also miss late rows.
- Aggregate labels: events, students, XP by filed course; basis = every Caliper result with `appName` Math Academy in the America/Chicago day, test users excluded or not (say which, and how the flag was read).
- Failure mode: taking one page as the day (trap 18); a UTC-day window for a local-day question (trap 17); attributing by enrollment (trap 21); windowing line items on `dateLastModified` too tightly and losing late-ingested rows; one `users/{id}` call per active student when the store list already carries the flag (a cold run spent 8 of 11 minutes there).

Output shape: one row per filed course — `course.sourcedId`, `course.name`, `students`, `events`, `xp`, `lessons`, `reviews`, `quizzes`, `multisteps`, `placements`, `exams`, `supplementals`; plus an `unattributed` row.

VERIFIED RUN (build 2026-09-16; two cold runs 2026-09-17): the cold runs produced the by-course table from line items and showed the enrollment-based join disagreeing on a meaningful share of rows, which is why B is the recipe.

### 9 · Student timeline — "Tell me this student's whole Math Academy story."

```
A. GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>'&limit=3000
      # keep course.name starting 'Math Academy' → every seat ever, with status, beginDate, endDate, course.sourcedId
B. GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy'&sort=scoreDate&orderBy=asc&limit=3000&offset=0   # page, all time
C. GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<id> for each distinct line item in B   # filed course per event: one GET per event (hundreds for a long history; the per-course listing is estate-wide and no cheaper for one student)
D. GET <front base>/store/student/<sid> and …/history   (token)   # Math Academy's current course, completion date, grade; the nightly history from 2026-09-17 on
      # assemble: per course (by FILED course, not seat) — first/last event, events count, signed XP sum, highest pctCompleteApp seen, placements, last LESSON date;
      # per seat — status, dates; events after the seat's dateLastModified when it is tobedeleted (the closest proxy for "filed under a deleted seat"; nothing serves the deletion time);
      # windows with events but no current Math Academy seat; event gaps over 7 days; where the percent first reached 100, the last lesson after it, and what seat began after
```

- Read this before trusting any single "current course" answer: a student's events are routinely filed under a deleted seat while a new seat sits empty (trap 21), and "finished" lives on Math Academy's `completed`, not on the seat or on a Timeback 100 (trap 3, ex. 5). The last **lesson** under a course is the Timeback-side date that has matched Math Academy's completion timestamp.
- XP earned per course is the signed sum of result `xp` under it; never the enrollment's `metrics.totalXp`.
- The gaps that matter are event gaps and seatless windows, not gaps between seats (seats overlap or abut). Seats closed on the exact days the rounded percent first touched 100 have been seen: progression may fire on the rounded 100 while Math Academy sits at 99.x.
- Whether the next seat is the right course is not decidable here (open question #7).
- Aggregate labels: per filed course, events and XP from results; time from weekly facts is optional, engaged, and a floor.
- Failure mode: assuming one seat per course; reading `primary`; using enrollment metrics as totals; dating "finished" from the first 100.

Output shape: one row per filed course, ordered by first event — `course.sourcedId`, `course.name`, `seats[] {status, beginDate, endDate, dateLastModified}`, `firstEvent`, `lastEvent`, `lastLesson`, `events`, `xpSigned`, `maxPct`, `first100`, `placements`, `eventsAfterSeatDeleted`; plus `seatlessWindows[]`, `eventGapsOver7Days[]`, and `store {currentCourse, completed, courseAgreement, historyDates}`.

VERIFIED RUN (two cold runs 2026-09-17): fresh agents assembled this for students with two to five seats; every derived figure reconciled with EduBridge's daily cells, and Math Academy's `completed` landed twelve seconds after the last lesson on both students where it was set.

### 10 · Math Academy's own figures — "What is her exact XP remaining, and is Timeback's course the right one?"

```
# the same Timeback token you use for every other call; the store replays it against Timeback and serves only students it can read
GET <front base>/store                                        # snapshotAt, snapshotAgeHours, stale, schedule, history[] {at, source}, lastActivityRun, snapshotCalls, readCalls, counts, byCourse  (no token; no student values)
GET <front base>/store/course/<course.sourcedId>              # that course's roster at snapshot time counted by courseAgreement, with testUsers, maNotStarted and a nonTest block (no token; counts only)
GET <front base>/store/course/<course.sourcedId>/students[?agreement=<value>]   # token: one row per roster student with store labels and Math Academy's course figures (no names); `rows` is the list, `count` the number
GET <front base>/store/courses                                # Math Academy course id -> name (the ids in mathAcademyCourseId / currentCourse.id)
GET <front base>/store/student/<user.sourcedId>[?minimal=1]  # Authorization: Bearer <your Timeback token>; minimal=1 drops username, names, league, schedule
GET <front base>/store/student?email=<student email>          # only when a person handed you an email; resolve once, then carry the id
```

- **Freshness rule.** Read `snapshotAt`, `snapshotAgeHours`, `stale` and `schedule` first. The store began on 2026-09-17 with manual loads and refreshes nightly from 2026-09-18 (03:00 America/Chicago; activity 03:45); `history[]` on `/store` lists every snapshot ever loaded with its `source` (`schedule`, `schedule-test`, `manual`), `schedule.firstScheduledRunHasHappened` says whether the cron has fired, `schedule.nextSnapshotDueUtc` when the next is due, and `lastActivityRun` what the last activity pull did (day, students, errors, calls, the UTC window). A day can hold more than one snapshot, so pin each figure to the `snapshotAt` on its own response. While `stale` is false (within `staleAfterDays`, two days as served), quote `xpRemaining`, `progress`, `grade` and `currentCourse` as "as of <figuresAsOf>". Once `stale` is true (a night was missed), still quote them only with their date, take progress from the newest result instead (ex. 3), and treat `courseAgreement` as indicative: the Timeback half is live, the Math Academy half is old. A stuck refresh is a ticket on the feedback wire.
- **Who has a row.** Every student with a current in-window Math Academy seat at `rosterReadAt`, plus students added by a lookup: a reader's first read of a missing student (`matchedBy: "live-lookup"`, even when the student has no current seat) or the activity pull meeting a student with results but no stored id (`activity-lookup`). Students progression has moved out of Math Academy, or left seatless, and nobody has read, are `courseAgreement: "not in snapshot"` until read once; most **finished** students are in that state (ex. 5). A student Math Academy does not know under this organisation's key stays `inSnapshot: false` with the HTTP reason and `lastTriedAt`, retried after 24 hours.
- **Cohort questions** go to `/store/course/{courseSourcedId}` (counts, no token; the top-level counts include test users, the `nonTest` block does not) and to `/store/course/{courseSourcedId}/students[?agreement=<value>]` (your token; one row per roster student with `courseAgreementAtSnapshot`, `mathAcademyState`, `mathAcademyCourseId`/`Name`, `progress`, `xpRemaining`, `completed`, `startDate`, `estimatedScore`, `isTestUser`, `matchedBy`, `figuresAsOf`, no names). That one call is the cohort answer with figures; per-student rows cost about one second each **and a miss costs one Math Academy call**, so never loop the per-student route over a roster.
- **What reaches Math Academy at read time:** nothing on `/activity`, `/history`, `/store`, the course routes and `/store/courses`; one live lookup when a per-student read meets a student missing from the store (once per 24 h per student); one knowledge-map fetch per student per course id per 7 days. `/store` counts the last two under `readCalls`, estate-wide.
- `mathAcademy.currentCourse.name` is the course Math Academy actually runs the student in; `courseAgreement` compares it with the student's live Timeback seats by one rule (normalised name match on any current seat; `, math academy course completed` appended when Math Academy has set `completed`): `agree`; `agree, math academy course completed` (both systems still on the finished course: parked); `disagree` (a roster defect: the student's events are being filed under a course Math Academy is not running, trap 10; report the Timeback course id and the Math Academy course name); `disagree, math academy course completed` (Math Academy still shows the finished course while Timeback's current seat is a different course; ask for the Math Academy-side move; whether the Timeback seat is the right next course is open question #7, and whether it was created before or after the completion is not decidable here); `no current timeback seat` (found by lookup, no seat); `math academy has no current course`; `no math academy record` (see `unmatchedReason`); `not in snapshot`.
- `xpRemaining` is exact and is the answer to "how much is left" (ex. 3), dated by `figuresAsOf`; it is served on SAT Math Prep too, where `progress` is null and `estimatedScore` carries Math Academy's predicted score.
- `matchedBy` and `matchConfidence`: `known` (id stored on an earlier night, the normal case), `lookup` / `live-lookup` / `activity-lookup` (Math Academy answered a per-student call keyed on the Timeback email), `username` (Timeback's `userProfiles` login equalled a bulk-list username), `name` (`matchConfidence: "low"`: a name-only match; say so or confirm through `userProfiles` before acting).
- `mathAcademyState`: `not started` (progress 0, not completed: the course is assigned and nothing done, whether `xpRemaining` reads 0 or the full course size; the student also has no Math Academy result in Timeback), `in progress`, `at 100, not marked complete` (progress ≥ 0.995 without a completion date; Timeback may show a rounded 100), `completed` (follows the `completed` date, open question #24). Report `not started` as "never started", never as "0 XP left".
- Two current seats: `courseAgreement` is `agree` if Math Academy's course matches **any** current seat; the seats are all listed, so report both.
- `figuresAsOf` is the timestamp of the read that produced the Math Academy figures (it equals `snapshotAt` on nightly rows); `figuresBasis` says whether Math Academy answered a direct per-student call (exact at that moment) or the figures come from its bulk list, which can lag the live record by up to a day.
- **Blind spot:** the store row carries no "last active" date; a student with a Math Academy record but no Timeback event under the current seat looks the same as an active one here. Take last activity from Timeback's newest result (ex. 1) or the store's activity days (ex. 11).
- Math Academy's own record is copied as served, artefacts included: `schedule.startDate` has been seen as the literal string `Invalid date` on a just-created account, and Math Academy's dates are local calendar dates that can post-date the snapshot reporting them. Treat any non-date string in a date field as null.
- Errors: no token → 401 with the instruction; a token Timeback rejects → 401 with `timebackStatus` 401; an id Timeback does not know → 404 with `timebackStatus` 404 (authentication is checked first, so an unauthenticated caller learns nothing about which ids exist); any other Timeback 4xx (a 414 for an absurd id) passes through with the same status; an email matching no or several Timeback users → 404 with `timebackMatches`; no id and no email → 400; an unknown `?agreement=` value on the list route → 400 with the allowed values.
- PII: `mathAcademy.username`, `firstName`, `lastName` are a child's identifiers; they stay in your session (dictionary § Students are children).
- Failure mode: quoting `xpRemaining` without its date; treating `disagree` on a `name`-matched row as certain; reading `not in snapshot` as "never on Math Academy"; reading a `not started` 0 as "finished".

Output shape: `user.sourcedId`, `snapshotAt`, `figuresAsOf`, `stale`, `matchedBy`, `matchConfidence`, `mathAcademyState`, `maCourse (name)`, `maCourseStart`, `progress (0–1)`, `xpRemaining`, `grade`, `letterGrade`, `estimatedScore (SAT Math Prep only)`, `completed`, `deactivated`, `timebackCourseSourcedId(s)`, `courseAgreement`.

VERIFIED RUN (build 2026-09-17; six cold runs 2026-09-17): the calls executed against the live store under read-only Timeback clients; cold agents read whole courses through the per-student route in about a second each and reconciled the counts and id sets with `/store/course` and its list exactly; the gate returned byte-identical 401s for existing and non-existing ids without a token; the exact figure sat between 15 percent below and 114 percent above the Timeback estimate across six students.

### 11 · Engaged versus productive time, and the course history — "Was he really working? When did she change course?"

```
GET <front base>/store/student/<sid>/activity?from=<YYYY-MM-DD>&to=<YYYY-MM-DD>     # Authorization: Bearer <your Timeback token>
      # tasks[]: Math Academy's own record per task with timeElapsedMs / timeEngagedMs / timeProductiveMs, type, xpAwarded, course, topic, taskId, startedEpochMs / completedEpochMs
      # days[]: the day's totals summed by the store over the kept tasks, ALSO in milliseconds (timeElapsedMs …), with windowUtc = the America/Chicago day as a UTC window
      # from/to are America/Chicago days (YYYY-MM-DD; both optional; 400 if malformed or reversed); activityLastDate = newest day the store has pulled
GET <front base>/store/course/<courseId>/activity?date=<YYYY-MM-DD>                   # token: every roster student's day totals for one pulled day in one call (the cohort form)
GET <front base>/store/student/<sid>/history                                          # one row per DATE since the store began: courseId, progress, xpRemaining, completed, grade, state, agreement
GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy' AND scoreDate>='<from>'&limit=3000
      # optional: Timeback's row for the same tasks; join on taskId == /tasks/<taskId>/ in metadata.originalObjectId; Timeback metadata.xp == store xpAwarded
```

- **Freshness first**, as in ex. 10: `snapshotAt`, `stale`, `storeBegan` and `activityLastDate` ride on every activity and history response. Capability 11 has data from 2026-09-16 onward only.
- **Days are pulled, not computed.** The store pulls a day for a student only if they had a Math Academy result in Timeback on that America/Chicago day, the night after (students with results but no stored id are looked up on the spot). A day absent from `days[]` was not pulled: before `storeBegan`, or no Timeback result that day, or last night's run has not reached it yet (`activityLastDate`); the response's `reasonIfEmpty` names which. A `days[]` row with `error` set means Math Academy refused that student's activity (HTTP status inside) or the student had no Math Academy id after the lookup. Never read absence as zero minutes.
- **These routes never reach Math Academy**; loop them over a cohort freely, or use the course form.
- **The day boundary is America/Chicago, enforced by the store.** Math Academy reads its own `startDate`/`endDate` on its own clock (a cold run found it to be UTC), so the store asks Math Academy for two of its days and keeps each task by its completion time inside the Chicago window it serves as `days[].windowUtc`. A task completed at 19:14 Chicago belongs to that Chicago day here; in Timeback its `scoreDate` is the next UTC day. Reconcile the two by task id, not by date.
- **Everything is milliseconds.** `timeElapsedMs`, `timeEngagedMs`, `timeProductiveMs`, `startedEpochMs`, `completedEpochMs` on tasks, and the same clock names on `days[]`. Divide by 60,000 for minutes. (Until 2026-09-17 evening the day totals were mislabelled as seconds; the field names now say what they are.)
- **The three clocks.** `timeElapsed` is wall time on the task; `timeEngaged` is the part Math Academy judged attentive, **and this is the clock Timeback receives as `activeSeconds`** (73 of 73 tasks in one cold run, exact to the second); `timeProductive` is the part that advanced the task and reaches Timeback nowhere. So Timeback's minutes already exclude idle wall time, and the elapsed-versus-engaged gap is visible only here. What the two extra clocks measure exactly is Math Academy's own analysis and **truly unknown**; the tells that held: elapsed far above engaged = a task left open (a two-task, three-hour day); engaged near elapsed with productive low = attentive but stuck (multistep problems ran about a third productive across a cohort); placements behave like lessons. Report ratios per day, not per task: a single review is seconds long. Aggregate labels: numerator and denominator in minutes, basis = tasks Math Academy recorded on the pulled days.
- `tasks[].xp` is the task's nominal value; `tasks[].xpAwarded` is what the student got and equals Timeback's `metadata.xp`. Sum `xpAwarded`.
- **Course history.** `history[]` starts the date the store began; a change of `courseId` between two dates is a course change and the last row of the old course carries `completed` if Math Academy had set it before the move (once moved, the main row no longer shows the old course). For anything older, use Timeback's results (ex. 9), which hold the Caliper half of the story back to the oldest reachable result.
- PII: none in these responses beyond `user.sourcedId`; the join to Timeback rows is by task id.
- Failure mode: treating a day with no `days[]` row as a day of zero work; reading any clock here as seconds; reconciling with Timeback by UTC date instead of by task id; computing "engaged share" from Timeback minutes (it is 100 percent by construction); reading `history` as Math Academy's full past when it starts at the store's first date.

Output shape: per day — `date`, `numTasks`, `elapsedMin`, `engagedMin`, `productiveMin`, `engagedShare`, `productiveShare`, `xpAwarded`, `timebackEngagedMin (from EduBridge, for the check)`; per course change — `fromCourseId`, `toCourseId`, `firstDateSeen`, `oldCourseCompleted (date or null)`.

VERIFIED RUN (build 2026-09-17 evening; three cold runs 2026-09-17): the activity pull ran for the previous local day; a cold run read 116 students of one course through the route in under two minutes, matched 592 of 592 task ids and 3,578 of 3,578 XP against Timeback, and showed EduBridge's minutes equal to the engaged clock on every student checked; history returned one row per date loaded so far.

### 12 · The knowledge map — "What does this student actually know?"

```
GET <front base>/store/student/<sid>/knowledge                 # Authorization: Bearer <your Timeback token>; current course; cached 7 days
GET <front base>/store/student/<sid>/knowledge?courseId=<mathAcademyCourseId>&refresh=1   # another course of theirs, or force one live call
```

- The first ask makes **one live Math Academy call** and caches the map for seven days **per `courseId`** (`fetchedAt`, `fromCache`); later asks are free. Together with the live lookup on a store miss, this is where a reader's request reaches Math Academy through the skill, so ask per student when a person needs it and **never loop it over a roster**. Math Academy's fair-use limit comes back as 429 with the same status; a wrong `courseId` (or a course the student never held) comes back as 404 with `studentCurrentCourseId`; anything else Math Academy refuses is 502 with `mathAcademyStatus`.
- **Response shape:** `{ sourcedId, courseId (a string), fetchedAt, fromCache, knowledge { courses[], requestedCourse {id, name, completion, indexInCourses, topics} }, note }`. `courses[]` holds up to two prerequisite courses **first** and the course asked for **last**; `courses[].id` is a number. Use `requestedCourse` or match on id; never take `courses[0]`. Asking for a prerequisite by `courseId` spends another live call for data already in hand. Walk `units[] → modules[] → topics[]`; `stability` (0–1) is Math Academy's estimate of long-term retention, averaged upward to module and unit; `completion` (0–1) per course.
- **Reading stability.** Exactly 0 means Math Academy has **no current retention evidence**: untaught topics read 0, and so does a topic the student just failed (a topic held three weeks read 0 within hours of a failed review). So split the zeros by Timeback's record: zeros with a task on record are the topics that just collapsed and belong at the **top** of a weakest list; zeros without one are untaught (open question #19). Low but non-zero stability on a topic whose only task is a lesson passed in the last day or two is **new, not yet reviewed**, not fading; call a topic fading only when its last pass is old. Non-zero stability on a topic with no Timeback task on record exists and is unexplained (open question #21). A topic absent from every course was never taught here.
- Pair it with ex. 6 (not-credited tasks by topic from Timeback): the map says what is held, the results say what was struggled with and when; lesson and review topic ids are the same numbers, quiz and multistep ids are not (trap 25). Carry each weak topic's last Timeback task date and type beside its stability.
- PII: none beyond `user.sourcedId`; topic names are curriculum, not the child.
- Failure mode: looping the call; taking `courses[0]` as the requested course; joining a string `courseId` to a numeric `id`; dropping the zeros; calling a topic learned yesterday "fading"; reading `stability` as a score on a test; quoting the map without `fetchedAt`.

Output shape: per course — `courseId`, `name`, `completion`; per unit — `name`, `stability`, `weakestTopics[] {topicId, name, stability, lastTimebackTask {date, type, credited} | null}` ordered zeros-with-a-task first, then lowest non-zero, ties by curriculum order; `untaughtZeros` count; a headline `topicsBelow(0.5)` with its denominator.

VERIFIED RUN (build 2026-09-17 evening; two cold runs 2026-09-17): live calls returned prerequisite courses first and the requested course last with unit, module and topic stability; second calls came from cache; one run found a just-failed topic at 0 and six freshly learned topics among the ten lowest non-zero, which is why the reading rules above exist.

## Cross-system notes

- The Math Academy task id and topic id inside the task URL are this source's only handles into Math Academy. They are claims; matching them to Math Academy's records is the caller's, over both systems.
- Timeback receives Math Academy's **engaged** clock (as `activeSeconds`) and never its elapsed or productive clocks, exact XP remaining, estimated SAT score, course grade, completion date, or per-topic knowledge map. All of those are in this skill's store, nightly or on demand; only something fresher than last night routes to the Math Academy API.
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

Standing open items, each a ticket on this wire: **#7** (which course ids progression honours), **#8** (Math Academy student id in Timeback), **#9** (null scores), **#10** (retention), **#11** (duplicate time rows), **#19** (knowledge stability 0), **#20** (Math Academy's pass rule and 0-XP rows), **#21** (stability without a task on record), **#22** (`pctCompleteApp` on SAT Math Prep), **#23** (Math Academy progress with no Timeback result), **#24** (when `completed` is set).
