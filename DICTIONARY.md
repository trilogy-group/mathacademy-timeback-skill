# mathacademy_timeback — dictionary

The product-management lens on **Math Academy data as it lives inside Timeback**. Every task a student completes on Math Academy reaches Timeback as a Caliper event and is stored in Timeback's own systems: OneRoster (results, line items, enrollments, classes, courses, users) and EduBridge analytics (per-event facts and daily rollups). This skill reads only those. It never calls the Math Academy API, and readers need only a Timeback credential.

Timeback **self-describes its structure** at `GET https://api.alpha-1edtech.ai/openapi.yaml` (OneRoster and gradebook routes, OpenAPI 3.1) and `GET https://api.alpha-1edtech.ai/edubridge/openapi.yaml` (EduBridge analytics, OpenAPI 3.1). Both are public. That is the table of contents; read it fresh. This file does not restate the schema. It adds the meaning the schema cannot carry: how each field is born, what its values mean, how the pieces connect, and the traps.

Math Academy is the core mathematics app for Alpha students in grades 4 to 12. A student is enrolled in one Math Academy course at a time (grade-level courses, Prealgebra, Algebra I, Geometry, Algebra II, Precalculus, Integrated Math, SAT courses, AP Calculus). Math Academy runs the student through lessons, reviews, quizzes, multistep problems, placements and exams, awards XP per task, and reports each completed task to Timeback as one Caliper event. This dictionary is for a reader who wants to know what a Math Academy student did, how they are doing in their course, and whether Timeback's record of them is coherent, without touching Math Academy itself.

## The native surface (how the reader reaches the data)

- **Base:** `https://api.alpha-1edtech.ai`. **Auth:** OAuth 2.0 client-credentials exchange. POST `grant_type=client_credentials` with the client id and secret (HTTP Basic or form fields) to the token endpoint `https://prod-beyond-timeback-api-2-idp.auth.us-east-1.amazoncognito.com/oauth2/token`; send the returned `access_token` as `Authorization: Bearer <token>` on every call. Tokens expire after `expires_in` seconds (one hour as served). A denied mint is a 401 to report, never to estimate past. The two OpenAPI files above are keyless.
- **What key:** a Timeback API client with **read-only** scopes for OneRoster rostering and gradebook and for EduBridge analytics (the scopes `powerpath.readonly` and `analytics/v1p0/readOnly` were sufficient for every call in this skill). One client per person or agent, never shared, requested from the Timeback platform team; this skill issues none. A 403 or an empty result on a route that works for others is a limit of your key or its org, not an absence of data.
- **Self-description:** the two OpenAPI files. Field inventories, enums, filter grammar and response shapes live there. A note on the filter grammar this dictionary relies on: OneRoster list routes take `filter=<field><op><value>` with `=`, `~` (contains), `>=`, `<=`, joined with ` AND `; dotted paths reach nested references (`student.sourcedId`, `class.sourcedId`, `metadata.appName`). The proprietary `search=` parameter on list routes is **ignored** (see trap 14).
- **Wire shape** (verified, probed 2026-09-16): list routes return `{ "<collection>": [ ... ], "totalCount", "pageCount", "pageNumber", "offset", "limit" }` with `limit` capped at 3000. Instance routes return `{ "<singular>": { ... } }`. Rows are nested objects (references are `{ "sourcedId", "href", "type" }` blocks). EduBridge analytics routes return one JSON object keyed by date, then subject, then (in `factsByApp`) app.
- **Scope:** a Timeback service credential reads all students in its organisation tree. Reads outside it return empty, not 403, so an empty result is not proof of absence unless the credential is known to cover the student (see trap 12 on test users, and the container list below).
- **Containers, and which fields each one carries** (this list is the RANGE of every absence claim in this document):

| Container | Native route | Carries for Math Academy |
|---|---|---|
| **assessmentResults** (Caliper-derived) | `GET /ims/oneroster/gradebook/v1p2/assessmentResults` | one row per completed Math Academy task: score, XP, questions, correct, mastered units, attempt, course completion percent, the Math Academy task URL (task id, topic id, task type), the Caliper event id, the student, the line item |
| **assessmentLineItems** | `GET /ims/oneroster/gradebook/v1p2/assessmentLineItems` | one row per Math Academy task instance: the topic title, the Timeback course it was filed under, the task URL |
| **enrollments** | `GET /ims/oneroster/rostering/v1p2/enrollments/` | the student's seat in a Math Academy class: dates, primary flag, daily goals, running totals, course completion percent with its timestamp |
| **classes** and **courses** | `GET /ims/oneroster/rostering/v1p2/classes/`, `.../courses/` | the Math Academy class and course objects, titles, grades, the org, course-level XP metrics |
| **users** | `GET /ims/oneroster/rostering/v1p2/users/` | the student, and a `userProfiles` entry for the Math Academy login (vendorId `math_academy`) |
| **EduBridge daily activity** | `GET /edubridge/analytics/activity` | per day, per subject, per app: XP earned, questions, correct, mastered units, active/inactive/waste seconds |
| **EduBridge weekly facts** | `GET /edubridge/analytics/facts/weekly` | the individual processed event rows for one student and one week: two rows per Math Academy task (an ActivityEvent and a TimeSpentEvent) |
| **EduBridge enrollment facts** | `GET /edubridge/analytics/enrollment/{enrollmentId}` | the same daily facts, scoped to one enrollment |

The completion percent lives in two containers (results and enrollments); XP per task lives in two (results and weekly facts); lesson titles live in two (line items and weekly facts). An absence claim about any of those must name which container was read. Task type lives in exactly one place, inside the task URL, in both results and line items. **Retention horizon:** Timeback publishes none for these containers. The oldest reachable Math Academy result is found with `GET .../assessmentResults?filter=metadata.appName='Math Academy'&sort=scoreDate&orderBy=asc&limit=1`; treat anything older than that as undecidable here, not absent.

## Provenance of this dictionary

- **Native docs** — the two OpenAPI files, read 2026-09-16. Citations `[docs:<route>]`. The platform's claims about its API, not truth; where a probe contradicts them both are kept.
- **Platform engineering note** — an internal Timeback note on how Math Academy Caliper events are processed and how students are onboarded into Math Academy, read 2026-09-16. Citations `[platform-note]`. Not reader-reachable; every load-bearing claim from it also carries a wire probe here.
- **Live probes** — dated in the build log (`BUILD-LOG.md` in this skill's repository), each confirming a piece of structure described below. A probe's value does not land here; the query does.
- **Cross-check against the Math Academy API** — during the build, one student's Timeback record was compared with the same student's Math Academy activity feed, and the completion percent of the whole active population was compared with Math Academy's progress figure. Those comparisons ground the invariants marked observed-empirically. The reader cannot re-run them without a Math Academy key, so each is stated with the Timeback-side query that tests the same relation where one exists.

## Genesis vocabulary

Every field below names its genesis in the contract's closed set: **captured** (from what?), **computed** (how? as of what?), **copied** (from where?), **judged** (by whom? when?), or **truly unknown**. Hybrids compose the lineage. Nearly everything Math Academy here is **copied**: Math Academy captured it, the Caliper event carried it, and Timeback stored it. A copied value is Math Academy's claim, stored by Timeback, and this dictionary says so rather than presenting it as Timeback's own measurement.

## The load-bearing rules

- **Every Math Academy task is one Caliper event, and the event is the unit of everything here.** `[platform-note]`, verified by probe. Timeback stores it as one assessmentResult whose `sourcedId` is `caliper_` plus the Caliper event id, one assessmentLineItem, and two EduBridge fact rows. Nothing arrives per question, per minute, or per login.
- **The Timeback course an event is filed under is the course of the student's ENROLLMENT, not the course Math Academy says the student is in.** `[platform-note]`, verified by probe on students whose two courses differ. This is the single most important thing in this document: if the enrollment is wrong, every event for that student is filed under the wrong course, and no field on the event says so. See trap 10 and ENABLEMENT example 7.
- **Timeback's progression engine acts on a Math Academy event only when the course completion percent reaches 100 and the course is on an approved list of Timeback course ids.** `[platform-note]`. TimeSpentEvents are skipped by progression. Every other event is stored and never acted on. The approved list is not served anywhere the reader can reach (open question #7).
- **Math Academy is grade 4 to 12 only** `[platform-note]`; a student below grade 4 in a Math Academy class is a roster fact to question, not a Math Academy fact.

---

# The native map (the census)

### assessmentResult (Caliper-derived) — one completed Math Academy task

- **one instance:** one task a student completed on Math Academy: a lesson, review, quiz, multistep problem, placement or exam. Genesis of the instance: **copied** (Math Academy emitted the Caliper event; Timeback's bridge adapter wrote the row).
- **id / identity:** `sourcedId` = `caliper_urn:uuid:<event id>`; the same uuid appears as `metadata.caliperSourcedId` and inside `metadata.relatedCaliperEvents[]`. Stable, one per event.
- **finished:** a result is written once, on ingestion, with `scoreStatus` `fully graded`. Nothing updates it. A student redoing a task produces a new event and a new result; `metadata.attempt` counts attempts on the same Math Academy task.
- **native:** list `GET /ims/oneroster/gradebook/v1p2/assessmentResults` with `filter`; instance `GET .../assessmentResults/{sourcedId}`. Filters honoured (probed 2026-09-16): `student.sourcedId='…'`, `scoreDate>='<ISO date>'`, `metadata.appName='Math Academy'`, `sourcedId~'caliper_'`, combined with ` AND `; `sort=scoreDate&orderBy=desc|asc`. Filter on `assessmentLineItem.course.sourcedId` is **rejected** (400, "Error in filter query"); to scope by course, list line items by course and join (see relationships).

### assessmentLineItem — the task instance the result grades

- **one instance:** one Math Academy task instance, created alongside the result. **copied.**
- **id / identity:** `sourcedId` = `caliper_` plus a 64-hex digest. One per result in practice.
- **finished:** written once.
- **native:** instance `GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/{sourcedId}`; list `GET .../assessmentLineItems?filter=course.sourcedId='…'` (honoured; large: order 10,000 rows per popular course, paginate at 3000).

### enrollment (in a Math Academy class) — the student's seat

- **one instance:** one student in one class. **captured** by Timeback's rostering (created by the platform's progression or by staff); the Math Academy-derived fields inside `metadata` are **copied** from the latest event.
- **id / identity:** `sourcedId` (uuid). The EduBridge weekly fact rows reference it as `enrollmentId`.
- **finished:** `status` moves to `tobedeleted`, or `endDate` passes. **Both must be read**: an enrollment can be `active` with an `endDate` in the past (trap 2).
- **native:** list `GET /ims/oneroster/rostering/v1p2/enrollments/?filter=class.sourcedId='…'` or `filter=user.sourcedId='…'`; `AND status='active'` is honoured.

### class and course — the Math Academy container objects

- **one instance:** a class is one section of a course at one org; a course is the catalogue object. Math Academy classes are titled `Math Academy - <course> Class` and are `metadata.is_automanaged: true` (created by the platform, not by staff). **captured.**
- **id / identity:** `sourcedId` on both; the class references `course.sourcedId`. Course ids are the stable key. Titles are not (trap 1).
- **native:** `GET /ims/oneroster/rostering/v1p2/classes/?filter=title~'Math Academy'`, `GET .../courses/?filter=title~'Math Academy'`, `GET .../classes/{id}/students` (returns `users`, not `students`, trap 15).
- **domain of the course field** (the dated observation, read 2026-09-16, re-derive with the courses call): 23 course rows carry a Math Academy title, across four orgs. In the main org: `Math Academy` (bare), `Math Academy - 4th grade`, `5th grade`, `6th grade`, `7th grade`, `Prealgebra`, `Algebra I`, `Geometry`, `Algebra II`, `Precalculus`, `Integrated Math I`, `Integrated Math I (Honors)`, `Integrated Math II (Honors)`, `Integrated Math III (Honors)`, `SAT Math Fundamentals`, `SAT Math Prep`, `AP Calculus AB`, `AP Calculus BC`, `Linear Algebra`. In three other orgs: `Math Academy - 8th grade` (a non-uuid id, no `primaryApp`), `Math Academy - Beyond AI` **twice** (two ids, one `active`, one `tobedeleted`, the only duplicated title), and a partner variant `Nice Academy - Math Academy 6th Grade CCSS Coverage` (`primaryApp` `nice_academy`, `tobedeleted`). The ids for each are in this skill's `reference/timeback-math-academy-courses.json`, with the regenerating call. This is a closed set only as observed; nothing enforces it.

### user — the student, with the Math Academy login on it

- **one instance:** one person. **captured** by the roster import.
- **relevant fields:** `email` (PII), `givenName`/`familyName` (PII), `grades[]` (Timeback's grade for the student, not Math Academy's course), `metadata.isTestUser` (trap 12), `userProfiles[]` where `vendorId = "math_academy"` carries the Math Academy login username (PII; **copied** from the onboarding call, `[platform-note]`). No Math Academy student id is stored anywhere on the user (open question #8). See § Students are children for what may leave the reader's session.
- **native:** `GET /ims/oneroster/rostering/v1p2/users/{sourcedId}`; `GET .../users/?filter=email='…'`.

### EduBridge daily activity — the day rollup

- **one instance:** one student-day, broken down by subject and (in `factsByApp`) by app. **computed** by EduBridge from the event rows, at read time for the range requested.
- **native:** `GET /edubridge/analytics/activity?email=…|studentId=…&startDate=<ISO datetime>&endDate=<ISO datetime>&timezone=<IANA>`. `timezone` decides which day an event lands in; omit it and days straddle midnight UTC.

### EduBridge weekly facts — the processed event rows

- **one instance:** one processed fact row. Two per Math Academy task: an `ActivityEvent` row (XP, questions, correct, mastered units) and a `TimeSpentEvent` row (active seconds). **copied**, with `source` naming the Timeback object it came from (`oneroster:assessment_result:caliper_…` or `caliper:event:…`).
- **native:** `GET /edubridge/analytics/facts/weekly?studentId=…&weekDate=<any date in the week>&timezone=<IANA>`. Returns the whole week Sunday to Saturday around `weekDate`.

### EduBridge enrollment facts — the day rollup for one enrollment

- **native:** `GET /edubridge/analytics/enrollment/{enrollmentId}?startDate&endDate&timezone`. Same shape as daily activity, scoped to one enrollment. Use it when a student holds more than one Math Academy enrollment (trap 2).

### Verbs

None. Every route here is a read. Progression, onboarding and enrollment changes are the platform's, out of this skill's scope and off limits to a reporting credential.

---

## assessmentResult — field meanings

`sourcedId`, `status`, `dateLastModified`, `student.sourcedId`, `assessmentLineItem.sourcedId` are captured with the row. `scoreDate` and everything in `metadata` is copied from the Caliper event Math Academy sent.

- `score` — percent correct on the task, 0 to 100, higher is better. **copied** (Math Academy's `questionsCorrect / questions`, rounded). `null` on a minority of rows; see trap 9. Not the XP.
- `scoreDate` — when the student completed the task, UTC. **copied** (equals Math Academy's task completion time, observed to the second on the build's cross-check). This is the field to sort and window on.
- `scoreStatus` — always `fully graded` as observed. `inProgress`, `incomplete`, `late`, `missing` are the strings `"false"` as observed (strings, not booleans).
- `metadata.appName` — `Math Academy` for every row this skill is about. **copied** from the sensor mapping. The filter `metadata.appName='Math Academy'` is the estate-wide selector (trap 16).
- `metadata.sensor` — `https://mathacademy.com`. **copied.** The Caliper sensor URL.
- `metadata.source` — `caliper`. Rows from other paths (native Timeback quizzes) carry other values and are not Math Academy.
- `metadata.originalObjectId` and `metadata.generatedId` — the Math Academy task URL, shape `https://www.mathacademy.com/tasks/<taskId>/topics/<topicId>/<type>` for topic tasks and `https://www.mathacademy.com/tasks/<taskId>/placement` for placements. **copied.** Three facts ride inside it and nowhere else as fields:
  - `<taskId>` — Math Academy's task id, a foreign id (a claim; matching to Math Academy is the caller's).
  - `<topicId>` — Math Academy's topic id, a foreign id. The same topic id recurs across students and across courses (trap 8).
  - `<type>` — the task type. Allowable values observed: `lesson`, `review`, `quiz`, `multistep`, `exam`, and `placement` (URL without a topic). `lesson` is new material in the current course; `review` is spaced repetition and routinely revisits earlier courses' topics; `quiz` and `multistep` follow lessons; `placement` is the entry diagnostic; `exam` is rare. Observed set, not enforced.
- `metadata.xp` — XP awarded for the task, an integer, **can be negative** (a failed review takes XP away; a failed lesson can award 0). **copied.** Higher is better; negative means the task was failed. The same number appears as `xpEarned` on the EduBridge ActivityEvent row.
- `metadata.totalQuestions`, `metadata.correctQuestions` — question counts on the task. **copied.** `correctQuestions` can be `null` on some rows while `totalQuestions` is set (observed); read `null` as not reported, never as zero.
- `metadata.masteredUnits` — Math Academy's count of units the task advanced. **copied.** 0 or 1 on nearly every row; meaning of larger values truly unknown.
- `metadata.attempt` — attempt number on this Math Academy task. **copied.** 1 on nearly every row.
- `metadata.pctCompleteApp` — the student's completion percent of their **Math Academy course** at the moment of this event, as a **string** of an integer 0 to 100. **copied.** Higher is further through the course. Equals Math Academy's own progress figure (invariant 2). Absent on some rows (observed on a minority). This is the only progress figure Timeback holds for Math Academy.
- `metadata.lessonType` — `external-lesson` for every Math Academy row. Structural marker that the content lives outside Timeback.
- `metadata.subject` — `Math`.

## assessmentLineItem — field meanings

- `title`, `description` — the Math Academy topic name. **copied.** Human label; the topic id in the URL is the key.
- `course.sourcedId` — the Timeback course this task was filed under. **copied from the student's enrollment at ingestion**, not from the event (load-bearing rule 2; trap 10).
- `metadata.externalUrl` — the same task URL as the result's `originalObjectId`.
- `metadata.courseId` — duplicate of `course.sourcedId`.
- `resultValueMin` / `resultValueMax` — 0 / 100.

## enrollment — field meanings

- `status` — `active` or `tobedeleted`. `active` alone does not mean current (trap 2).
- `beginDate`, `endDate` — the seat's window; `endDate` may be null (open) or in the past while `status` is still `active`.
- `primary` — the string `"true"` on the student's main course enrollment. A student can hold one primary and several non-primary Math Academy enrollments (old courses, an SAT course).
- `metadata.pctCompleteApp` — the latest course completion percent, an **integer** here (a string on the result). **copied** from the latest event. Present only after the first event arrives (trap 3).
- `metadata.pctCompleteAppUpdatedAt` — when that percent was last written, UTC. The staleness clock for the percent.
- `metadata.metrics.totalXp`, `totalLessons`, `totalGrades` — Timeback's running totals for this enrollment. **computed** by Timeback from the events it received. This is the student's earned XP in the enrollment, not the course's size; the course's size is `course.metadata.metrics.totalXp`.
- `metadata.goals.dailyXp`, `dailyLessons`, `dailyActiveMinutes`, `dailyAccuracy`, `dailyMasteredUnits` — Timeback's daily targets for the enrollment. **judged** (platform defaults, overridable by staff). These are Timeback's goals, not Math Academy's schedule.
- `metadata.completionType`, `completionReason` — present on enrollments a person closed manually; free text.

## course — field meanings

- `title` — see the domain above. Not canonical: one title (`Math Academy - Beyond AI`) names two course ids, one course is titled just `Math Academy`, and class titles derived from course titles vary in case (trap 1).
- `grades[]` — the grade band the course is intended for.
- `metadata.primaryApp` — `math_academy` on 19 of the 23 rows; absent on `Math Academy - 8th grade` (which lives in another org under a non-uuid id) and on the `tobedeleted` `Beyond AI` row; `nice_academy` on the partner variant. Not a reliable selector for "is this a Math Academy course"; use the title filter plus the id list.
- `metadata.metrics.totalXp` — the course's size in XP, set by the school from Math Academy's published XP-with-reviews figure for that course. **judged** (by the school, per course). The denominator for the XP-remaining estimate; some courses still carry an older lower figure (trap 11). Absent on the bare `Math Academy` course and the `Beyond AI` courses.

## EduBridge — field meanings

- `activityMetrics.xpEarned`, `totalQuestions`, `correctQuestions`, `masteredUnits` — sums over the day (daily activity) or the single event (weekly fact). **computed** from the copied result rows.
- `timeSpentMetrics.activeSeconds`, `inactiveSeconds`, `wasteSeconds` — seconds. `activeSeconds` for Math Academy is the task's elapsed time as Math Academy reported it. `inactiveSeconds` and `wasteSeconds` are **always 0 for Math Academy** (trap 4): Math Academy sends no waste signal; zero means unmeasured, never clean.
- `apps[]` — the apps contributing to the cell; `Math Academy` is the label.
- weekly fact `eventType` — `ActivityEvent` or `TimeSpentEvent`; `activeSeconds` arrives as a **string** with two decimals; `activityId` is the Math Academy topic URL on TimeSpentEvent rows and null on ActivityEvent rows; `activityName` is the topic title on both.

## Derived quantities this skill teaches (never fields on the wire)

- **Estimated XP remaining in the current course.** Math Academy does not send its XP-remaining figure to Timeback. Every input for the estimate is on the wire: `remaining ≈ course.metadata.metrics.totalXp × (1 − pctCompleteApp / 100)`, basis "timeback course XP". **computed** by the reader from two copied inputs. `course.metadata.metrics.totalXp` is the course's size in XP as the school sets it from Math Academy's published XP-with-reviews figure (**judged**, by the school, per course; see trap 11 for courses where it has not yet been set to that figure). Read it live from the course object, never from a copy. The rule order, including the two cases with no estimate, is in `reference/course-xp-size.json`:
  1. Course carries no `totalXp` (the bare `Math Academy` course, the `Beyond AI` courses): no estimate.
  2. SAT Math Prep: no estimate. Math Academy reports an estimated SAT score there instead of progress, a figure Timeback never receives, so `pctCompleteApp` on that course is stale or absent. SAT Math Fundamentals still reports progress and is estimated like any other course.
  3. Enrollment carries no `pctCompleteApp`: no estimate yet (trap 3).
  The estimate is only as good as `pctCompleteApp` (invariant 2) and the course figure (trap 11); always name the basis.
- **Suspect-course flag.** Whether the events for a student point at a course other than the one they are enrolled in, inferred from lesson topic ids (ENABLEMENT example 7). A heuristic with a stated false-alarm profile (trap 8), never a verdict.

## Expected invariants

1. **One result, one line item, two weekly fact rows per Math Academy event.** Standing: **observed-empirically**. Test: for one student and one week, count results with `metadata.appName='Math Academy'` in the window, count weekly fact rows with `app = "Math Academy"` grouped by `eventType`; expect results = ActivityEvent rows = TimeSpentEvent rows.
2. **`pctCompleteApp` equals Math Academy's own course progress.** Standing: **observed-empirically** during the build across the active population (agreement within two points for the large majority). Not testable from Timeback alone; the Timeback-side consistency check is that `pctCompleteApp` never decreases across a student's results in one enrollment ordered by `scoreDate`, except when the enrollment changes course.
3. **Daily `xpEarned` for Math equals the sum of `metadata.xp` over that student's Math Academy results that day.** Standing: **observed-empirically**. Test: sum results by day (in the same timezone passed to EduBridge) and compare with `facts[<day>].Math.activityMetrics.xpEarned` where `apps` is only `Math Academy`.
4. **`scoreDate` is the task completion time.** Standing: **observed-empirically** on the build's cross-check with Math Academy. Consequence: a result's `dateLastModified` is minutes later than `scoreDate` (ingestion lag) and is not the activity time.
5. **A student has at most one primary active Math Academy enrollment within its date window.** Standing: **expected-but-violated**. Some students hold two active in-window Math Academy enrollments. Query: enrollments filtered by `user.sourcedId`, keep `status='active'`, class title containing `Math Academy`, today inside `beginDate..endDate`; count > 1 is the violation. Do not weaken the definition; report the rows.
6. **`score` = round(100 × `correctQuestions` / `totalQuestions`).** Standing: **observed-empirically** where both counts are present. Rows with `null` score or `null` correct break the test by absence, not by contradiction.

---

## Known traps

Each carries the query that measures its blast radius today; no figure of this document's travels with it.

1. **Class and course titles are not canonical.** One course title, `Math Academy - Beyond AI`, names two course ids; one course is titled just `Math Academy`; the `8th grade` course lives in a different org under a non-uuid id; a partner org carries a `Nice Academy - Math Academy …` variant; and class titles, which are built from course titles, appear with differing case for the same grade. Joining or grouping on title merges or splits courses. Use `course.sourcedId`; the id list is in `reference/timeback-math-academy-courses.json`. Measure: `GET .../courses/?filter=title~'Math Academy'&limit=100`, group by title, count titles with more than one id; and `GET .../classes/?filter=title~'Math Academy'&limit=3000`, group by lower-cased title, count titles that appear in more than one spelling.
2. **An `active` enrollment can be over.** `status='active'` with `endDate` in the past is common; a student also keeps old Math Academy enrollments beside the current one. Current means `status='active'` AND today within `beginDate..endDate` (null `endDate` = open). Measure: list a class's enrollments, count `active` rows whose `endDate` < today.
3. **`pctCompleteApp` exists only after the first event.** A freshly created enrollment has no percent; absence means no event yet, not zero progress. And the percent is as old as `pctCompleteAppUpdatedAt`. Measure: enrollments in Math Academy classes with `status='active'` and no `metadata.pctCompleteApp`.
4. **Waste is always zero for Math Academy.** `wasteSeconds` and `inactiveSeconds` are 0 on every Math Academy cell because the app sends no such signal. A dashboard that reads zero waste as good behaviour is wrong. Measure: weekly facts for any Math Academy student, count rows with `wasteSeconds != "0.00"`.
5. **Two fact rows per task.** Summing weekly facts without filtering `eventType` double counts events and mixes XP rows with time rows. XP and questions are on `ActivityEvent` rows; seconds on `TimeSpentEvent` rows; `correctQuestions` may be null on ActivityEvent rows. Measure: for one student-week, count rows by `eventType`.
6. **Duplicate time rows are reported upstream.** The timeback_production skill reports literal duplicate TimeSpentEvent rows in the processed-facts store for some students. Not measured in this build; dedupe on (student, timestamp, activity, seconds) before summing time. Measure: weekly facts, count exact-duplicate TimeSpentEvent rows.
7. **The task type is inside the URL, and placements have no topic.** Nothing else on the row says lesson vs review. Parse the last path segment; handle `/tasks/<id>/placement` separately. Measure: count results whose `originalObjectId` matches neither URL shape.
8. **Reviews revisit earlier courses, and adjacent courses share topics.** Inferring a student's course from topic ids works only on `lesson`, `quiz` and `multistep` events, and even then adjacent grade-level courses share many topics, so a student in a grade N class doing grade N−1 lesson topics is common and usually legitimate. Any topic-to-course map is a majority label, not Math Academy's catalogue. Measure: build the map (ENABLEMENT ex. 7 step A) and count topics whose top course holds under 80% of the votes.
9. **Some results have no score.** A minority of Math Academy results carry `score: null` with `correctQuestions` null. Meaning truly unknown (a task type with no questions is the likely cause). Read as unreported. Measure: results with `metadata.appName='Math Academy'` in a window, count `score` null.
10. **The filed course is the enrollment's course, not Math Academy's.** If Timeback enrolled a student in one course while Math Academy runs them in another, every event is filed under Timeback's course, `pctCompleteApp` reports progress in Math Academy's course, and the line item's `course.sourcedId` cannot reveal the difference. Detecting it from Timeback alone is heuristic (example 7); the definitive check needs the Math Academy API, which is outside this skill. Measure: run example 7 over a cohort and count students flagged.
11. **Some courses' `totalXp` has not yet been set to Math Academy's XP-with-reviews figure.** The school sets `course.metadata.metrics.totalXp` from Math Academy's published per-course XP; on 2026-09-17 several courses still carried an older, lower figure and the owner is correcting them. Until a course is corrected, an XP-remaining estimate on it reads low. Standing: **expected-but-violated**. Measure: for one course, compare `course.metadata.metrics.totalXp` with the median over its active students of `enrollment.metadata.metrics.totalXp ÷ (pctCompleteApp/100)`; a course whose students' implied size sits well above its `totalXp` is one not yet set. Never use `totalXp` as a denominator for progress; progress is `pctCompleteApp`.
12. **Test, shadow and demo accounts sit in real classes.** `users.metadata.isTestUser` marks some; others are only recognisable by name patterns or by their org. Any count of Math Academy students includes them unless filtered. Measure: students of a Math Academy class, count `metadata.isTestUser = true`.
13. **The Timeback grade is not the Math Academy course.** `users.grades[]` is the student's enrolment grade; Math Academy places students by placement test, often one or more courses above or below. Never infer course from grade or grade from course.
14. **`search=` is ignored on OneRoster list routes.** It returns the full unfiltered collection with a normal 200. Use `filter=title~'…'`. Measure: compare `totalCount` with and without `search`.
15. **`/classes/{id}/students` returns `users`.** The array key is `users`, not `students`; a reader keyed on the documented name gets an empty list and a clean 200.
16. **The estate-wide selector is undocumented.** `filter=metadata.appName='Math Academy'` works today and is the only way to read all Math Academy events without a student list. It is not in the OpenAPI filter list; re-check it before relying on it. Measure: the call with `limit=1`, expect `totalCount` > 0.
17. **Timezone decides the day.** EduBridge daily cells move with the `timezone` parameter; OneRoster `scoreDate` is UTC. Pass the campus timezone and use the same one when reconciling.
18. **Pages cap at 3000 and `totalCount` is the truth.** Loop on `offset` until `offset >= totalCount`; a short page mid-way is not the end.
19. **Filtering results by course is rejected.** `assessmentLineItem.course.sourcedId` in a results filter returns 400. Scope by course through line items, or through the students of the course's classes.

## Relationships

- `assessmentResult.assessmentLineItem.sourcedId` → `assessmentLineItem.sourcedId`; `assessmentLineItem.course.sourcedId` → `course.sourcedId`.
- `assessmentResult.student.sourcedId` → `user.sourcedId` → `enrollment.user.sourcedId`; `enrollment.class.sourcedId` → `class.sourcedId` → `class.course.sourcedId`.
- EduBridge weekly fact `enrollmentId` → `enrollment.sourcedId`; fact `source` → the result's `sourcedId` (ActivityEvent) or the Caliper event id (TimeSpentEvent); fact `courseId` → `course.sourcedId`.
- Foreign ids held here as claims: the Math Academy task id and topic id inside the task URL, and the Math Academy login username on `userProfiles`. Matching any of them to Math Academy's own records is the caller's, across both systems' contracts. This skill builds no crosswalk to Math Academy.

## Students are children — what a reader may publish

Every student-level row this source serves is about a minor. The identifiers on the wire (`user.sourcedId`, `email`, names in `givenName`/`familyName`, the Math Academy login username on `userProfiles`, and `enrollment.user.name`) are **person-bearing fields, marked here as PII**. A reader may use them inside its own work to join and to answer the question it was asked. A reader **publishes none of them**: anything that leaves the reader's session (a report, a dashboard, a ticket, a message to a third party) carries counts, classes, course ids, opaque student ids that the recipient is already entitled to resolve, or aggregates, and never a child's name, email or login, and never a row that identifies one child on its face. The worked examples in the enablement therefore key their outputs on `user.sourcedId`, not on email, and resolve email to id as the first step where a person hands the reader an email. This is stated by this skill's front under `pii` and binds every surface built on this source.

## Open questions — what this document does NOT assert

Filed as tickets on this skill's own feedback wire (route published in the `/skill` front under `feedback`; each is readable at `GET <feedback.open>/{number}` and mirrored daily to a GitHub issue on the repo named there). Stated open, never guessed:

- **#7 — Which Timeback course ids are on the progression's approved Math Academy list.** The platform note says a fixed list exists; it is not served. This document does not assert which classes count for progression.
- **#8 — Whether Timeback stores the Math Academy student id anywhere.** The onboarding response returns it; no reader-reachable field carries it. This document asserts only that the login username is on `userProfiles`.
- **#9 — The meaning of `score: null` and `correctQuestions: null` on Math Academy results.**
- **#10 — Retention of Caliper-derived results and EduBridge facts.** No horizon is published; absence claims here are bounded by the oldest-reachable-record query.
- **#11 — Whether the duplicate TimeSpentEvent rows reported upstream affect these routes.**
