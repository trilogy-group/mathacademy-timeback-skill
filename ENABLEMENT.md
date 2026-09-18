# mathacademy_timeback — enablement

How to put Math Academy data to work for Alpha's students. Worked examples are direct instruction: guidance, not truth. The dictionary governs meaning; the live OpenAPI files govern shape. Read both fresh.

**Two halves, in this order.** Math Academy's own record of a student's work lives in **this skill's store**: every student's current course, progress, XP remaining, grade, SAT estimate and completion flag (refreshed nightly), every task they ever did from 2025-07-01 with Math Academy's three clocks and its own course attribution (backfilled, then nightly), a nightly course history, and the knowledge map on request. **Start there for every question about what a student did, how far they are, how they work, what they know, who finished and who is quiet.** Timeback holds the other half: **who sits where**. Rosters, sections, seat dates, the test-user flag, grades, and the Timeback course each event was *filed* under. Read Timeback for the roster and for roster hygiene; read Timeback's results container only for the three things the store cannot answer (Part B): what happened today before tonight's pull, which Timeback course an event was filed under, and a reader who has no store access.

The reader brings one credential: a read-only Timeback client. The store's student and course routes replay that token against Timeback and serve only students the token can read; the reader never calls Math Academy, and the store's own Math Academy key never reaches the wire. Siblings answer the other subjects: **timeback_production** (front `https://timeback-loops-k8.vercel.app/dss/timeback_production/skill`) and **timeback_analytics** (front `https://platform.timeback.com/mcps/analytics/skill`) hold the whole learning record across every app, MAP testing and mastery, screen-capture minutes and waste; **the Math Academy API itself** holds only what is fresher than last night or never pulled, reached as a one-off per § One-off exact figures.

**Base for Timeback calls:** `https://api.alpha-1edtech.ai`. **Base for store calls:** the front's `{{BASE}}` (`<front base>` below). Every call: `Authorization: Bearer <token>`, minted once per hour from the Cognito client-credentials endpoint with the one POST a read-only reader makes (dictionary § native surface); cache the token, mint again on 401, retry a connection reset or 5xx once.

## How to work

- **Read `GET <front base>/store` first, every session.** It is open. `snapshotAt`, `snapshotAgeHours`, `stale`, `activityLastDate`, `lastActivityRun` (with `daysPulled[]`), `backfill`, `schedule`, `health` and `readCalls` tell you what last night did and how fresh every figure you are about to quote is. Print `snapshotAt` (or the task's `date`, or `fetchedAt`) beside every store figure. While `stale` is false (within two days), the store's figures are the answer; once `stale` is true, still quote them with their date and say a night was missed.
- **The store is Math Academy's record; Timeback is the seat.** `mathAcademy.currentCourse` is the course Math Academy is actually running the student in; `timeback.currentMathAcademySeats` (read live with your token on the same response) is where Timeback has seated them; `courseAgreement` compares the two. When they disagree, both are facts: report both and route the disagreement to the platform team (open question #7); never "correct" one with the other.
- **Loops that are free and loops that are not.** `/store/course/{id}`, `…/students`, `…/activity?date=`, `/store/finishers`, `/store/student/{sid}/history` and `…/courses` never reach Math Academy: loop them over a cohort freely. `/store/student/{sid}` makes one Math Academy call only when the student has no row or left the roster (once per 24 h). `…/activity` reaches Math Academy only for a student the backfill has not covered (`coverage.backfilledAt` unset: about five calls, once). `…/knowledge` makes one live call per student per course id per week (a 404 is cached a day): ask per student when a person needs it, never over a roster. `readCalls` on `/store` counts all of it, estate-wide.
- **Test users.** Use the store's `isLikelyTest` (Timeback's `isTestUser` flag OR a synthetic naming pattern OR a test campus, judged server-side) on every list row and student row, and say that you did. Timeback's flag alone is a floor (one course: 234 real students by the flag, 209 by `isLikelyTest`). Never inspect names to guess (trap 12).
- **The students are children.** Key everything on `user.sourcedId` (not uniformly a uuid: some ids are `user_...` or `pcb-course-...` strings; never truncate any id, student or course, in a join: two 5th-grade student ids share their first eight characters and two course ids share `pcb-course-`); resolve an email or a name to an id once, at the start (names collide: Part B1 gives the disambiguation rule); let nothing person-bearing leave your session; scrub cached Timeback responses **by path** (`user.name`, `users[].givenName/familyName/email`, `facts[].email`, `mathAcademy.username/firstName/lastName`), or use `?minimal=1` on the store. Curriculum names (`courseName`, `topicName`, `knowledge.courses[].name`, `units[].name`, `topics[].name`) are not person-bearing and stay. **Course and class titles other than the `Math Academy - …` titles in `reference/timeback-math-academy-courses.json` are treated as person-bearing** (courses built for one student carry the child's name): describe them by kind, never quote them (dictionary § Students are children).
- **Timezone: America/Chicago.** The store's days are Chicago days already (`days[].windowUtc`). When you touch Timeback, bound `scoreDate` with both ends of the Chicago day as UTC instants (05:00Z to 05:00Z in CDT, 06:00Z in CST) and pass `timezone=America/Chicago` to EduBridge. Say which zone you used.
- **The range of an absence.** A day absent from a backfilled student's `days[]` between `backfilledFrom` and the day before `activityLastDate` is a day with no Math Academy task. An absent `activityLastDate` day is "no row yet" (3 to 8 percent of Timeback's rows for a day arrive after the 03:45 pull, measured on three days; tonight's re-pull picks them up). A day after `activityLastDate` is not pulled yet. `daysRequested[]` says which per day; never read absence as zero minutes. "Not in the store" means Math Academy does not know the student under this organisation's key (`unmatchedReason`), or the student never held a Math Academy seat since the store began. Two rarer cases: a **roster student with daily Timeback results and `unmatchedReason` HTTP 404** (Timeback holds the work, the store cannot match the account: a platform ticket, and the reader answers from Timeback, Part B); and a **backfilled student whose Timeback events come from another Math Academy account** or whose account is `deactivated` (the store's days can be missing while Timeback holds tasks; `coverage.note` warns on deactivated accounts; compare the two before reading an absent day as no work).
- **Pace and habits, when asked "how is she doing".** Over a week or more: **minutes to earn 1 XP** = `timeEngagedMs ÷ 60000 ÷ xpAwarded` over ALL tasks of the window, with the task mix beside it (a second figure over lessons only may be added, labelled so; the two can disagree, so never mix them; 0.9 to 1.1 is the good zone for LESSON-heavy work; reviews, quizzes and exams pay XP faster, so report the task mix beside it and never call a low figure "racing" unless the negative-XP share says so; below 20 XP in the window report "no pace"); **share of lessons with negative XP** (rushing and guessing, a habit) and **share of lessons with zero XP** (failed, a difficulty), over lessons only, labelled so, and never merged (dictionary § Derived quantities).
- **The three clocks.** `timeElapsedMs` is wall time; `timeEngagedMs` is the part Math Academy judged attentive (and the only clock Timeback receives, as `activeSeconds`); `timeProductiveMs` is the part that advanced the task. Elapsed far above engaged = a task left open; engaged near elapsed with productive low = attentive but stuck. Report ratios per day, not per task. Everything is milliseconds.
- **Aggregation is yours.** When you emit an aggregate, name the numerator, the denominator and the roster basis (which students, filtered how, test users in or out). Course totals from the store are by **roster membership** (every roster student's Math Academy work wherever Math Academy filed it); "filed under this Timeback course" is a Timeback question (Part B).
- **Small shapes readers tripped on.** A seat object (`timeback.currentMathAcademySeats[]`, `seatsAtSnapshot[]`) has no `endDate` key when the seat is open (absent, not null), like Timeback's row. Unmatched list rows carry `lastTriedAt` and `unmatchedReason`. `classSourcedIds[]` on a list row are the sections in THIS course only (a two-seat student shows one here). `history[]` rows omit `progress` (absent, not null) where Math Academy serves none (SAT Math Prep). `completed` is served as Math Academy sends it, an ISO instant in UTC (`…Z`); `/store/finishers` compares its UTC date. Timeback's `limit` above 3000 is a 422, not a silent cap. Timeback's `score` rounds half up on every row checked but one placement at 23 of 40 served 57 (a floating-point 57.4999), so treat a one-point difference as rounding.
- **Small shapes readers tripped on, continued.** Math Academy can RESTART a course for a student: a new `currentCourse.startDate` with prior credit (one student read 43 percent in Timeback on 21 August and 91 percent with a `startDate` of 15 September), so a progress jump across a new `startDate` is placement, not work, and `startDate` can post-date the student's first task. `/store/courses` can map two Math Academy ids to one name (ids 22 and 127 both read "Integrated Math I (Honors)"): key on the id. `seatsAtSnapshot[]` (written at load) carries `endDate: null` and `primary` and no `enrollmentSourcedId`, while the live `timeback.currentMathAcademySeats[]` omits `endDate` when open; treat the two as the same seat by `classSourcedId`. `/store/finishers` answers 400 to a malformed `since` or a non-numeric course id. `figuresAsOf` on a directly refreshed row can predate `snapshotAt`: print the row's own date.
- **A permission error is a key limit, not an absence.** 401 means mint again; 403 means the credential does not cover the route; a 401 `unmatchedReason` on a store row means the student sits under another organisation's Math Academy key. Report either; never estimate past it.

## Capabilities — what you can answer here

Each is buildable by a cold agent with `GET /skill`, this pair, and a Timeback credential. This list is the claim surface.

1. **A student's Math Academy task history** — every task since 2025-07-01 with Math Academy's type, topic, course, XP awarded, questions and three clocks (store).
2. **A student's daily and weekly totals** — tasks, XP, engaged / elapsed / productive minutes per Chicago day, with pace and habits measures (store).
3. **A student's current Math Academy course and how far through it they are** — Math Academy's course, progress, XP remaining, grade, SAT estimate, completion flag, dated, with whether the Timeback seat agrees (store).
4. **Who is active and who has gone quiet in a Timeback course** — roster from the store's course list, activity from the store's course-day totals, and an ordered set of reasons for each quiet student (store; Timeback only for seats begun since the last load).
5. **Who has finished** — Math Academy's own completed flag for every student who ever held a seat, plus course changes in the nightly history; Timeback's rounded 100 for finishes Math Academy has already moved past (store first; Part B for the older half).
6. **Where a student is struggling** — negative-XP and zero-XP tasks by Math Academy topic, recovery, and the knowledge map beside them (store).
7. **Whether a Timeback course is the one Math Academy runs** — `courseAgreement` per student, counts per course, the rows behind them (store; definitive as of the snapshot).
8. **Estate-wide activity for a day or a week** — every course's roster students' Math Academy work per Chicago day (store); the Timeback-filed view in Part B.
9. **A student's whole Math Academy story** — Math Academy's course episodes from the task record, the nightly history, and Timeback's seats beside them (store + Timeback enrollments).
10. **Cohort counts and roster hygiene** — how many agree, disagree, have no record, never started, sit two seats, are below grade 4, are deactivated, are test accounts (store).
11. **Engaged versus productive time** — the three clocks per task and per day, per student or per course (store).
12. **The knowledge map** — per-topic retention (stability 0–1) for the student's course and its prerequisites, fetched live once and cached (store).

## Question → composition catalog

| The user asks… | Compose |
|---|---|
| "What did this student do on Math Academy this week?" | `GET <front base>/store/student/{sid}/activity?from=&to=` (A2): Math Academy's own tasks with type, topic, course, XP, clocks |
| "How many minutes and XP per day?" | the same call: `days[]` (A2); EduBridge only for a reader without store access (B3) |
| "What course is she in and how far along?" | `GET <front base>/store/student/{sid}` (A3): course, progress, XP remaining, grade, agreement, dated; the live seats are on the same response |
| "Who is active in this course this week?" | `GET <front base>/store/course/{id}/students` for the roster, then `…/activity?date=` for each day (A4); no Timeback results read |
| "Who in this course hasn't touched Math Academy in two weeks?" | A4: roster minus the students with a store day in the window, then one kind per quiet student from the list row's fields and their `/courses` or `/activity` (free) |
| "Who finished?" | `GET <front base>/store/finishers?since=` (A5) for Math Academy's own flag; `/history` for course changes since 2026-09-17; Part B6 (Timeback's 100) for finishes Math Academy has already moved past |
| "Where is he struggling, and did he recover?" | `…/activity` tasks grouped by Math Academy `topicId` (A6) + `…/knowledge` (A10) |
| "Is anyone in the wrong course?" | `GET <front base>/store/course/{id}` counts, then `…/students?agreement=disagree` (A7) |
| "How much Math Academy happened yesterday across the school?" | `…/activity?date=` for each course in the reference file (A8); the filed-under-course view is B7 |
| "Tell me this student's whole Math Academy story." | `…/courses` (Math Academy's episodes) + `…/history` + Timeback enrollments for the seats (A9) |
| "What is her exact XP remaining / true course / SAT score / grade?" | `GET <front base>/store/student/{sid}` (A3), dated by `figuresAsOf` |
| "Was he actually paying attention? How much of the time was productive?" | `…/activity` (A2): elapsed / engaged / productive per task and per day |
| "How focused was my class yesterday?" | `…/course/{id}/activity?date=` (A4, A8): one call, every roster student's day totals and the class totals |
| "Give me the estate picture / roster defects" | `GET <front base>/store` with your token (counts, byCourse) and the course lists (A11) |
| "What does this student actually know? Where is she weak?" | `…/knowledge` (A10): one live call on first ask, cached 7 days; never loop it |
| "What happened today?" / "Which Timeback course were her events filed under?" / "I have no store access" | Part B (Timeback's containers) |
| "I need it fresher than last night" | one direct Math Academy call with the organisation's key (§ One-off exact figures), never a loop |

---

## Part A — worked examples, Math Academy first

Every store call carries `Authorization: Bearer <your Timeback token>`. Every VERIFIED RUN line names what was checked and on how many students or rows; those are the bounds of the claim, not a guarantee about the next student. Every figure in these documents that carries a date (114 students, 7 near-finishers, 13 late students ...) is an observation on that date, kept so a reader knows the size of the effect; the wire on the day you read it is the value, and a difference is drift, not a defect.

### A1 · Start here — freshness, and the student's row

```
GET <front base>/store                                        # open: snapshotAt, snapshotAgeHours, stale, activityLastDate, lastActivityRun {day, students, errors, maCalls, windowUtc, rePull, daysPulled[], maCallsWholeRun}, backfill, schedule, health, readCalls; with your token also counts and byCourse
GET <front base>/store/student/<user.sourcedId>[?minimal=1]   # token; minimal=1 drops username, names, league, schedule
GET <front base>/store/student?email=<student email>          # only when a person handed you an email; resolve once, then carry the id
```

- **Freshness rule.** The store loads nightly at 03:00 America/Chicago and pulls activity at 03:45; `history[]` on `/store` lists every load with its `source` (`schedule`, `schedule-test`, `manual`); a day can hold more than one load, so pin each figure to the `snapshotAt` on its own response. `activityLastDate` is the newest fully pulled day; `lastActivityRun.daysPulled[]` lists the days last night pulled (the overlap day first, re-pulled for late rows, then yesterday); `day` and `rePull` describe the last of them and `maCalls` the whole run (the 2026-09-18 list was written from the run's log, `daysPulledNote` says so). `backfill.status` says whether every student who ever held a seat has their whole activity in the store (`complete` since 2026-09-18).
- **Who has a row.** Every student on the Timeback Math Academy roster at the last load, every student who ever held a seat (the backfill matched them by one direct call: `matchedBy: backfill-lookup`), and anyone a reader asked for who Math Academy knows (`live-lookup`). A student who left the roster keeps their row with `offRosterSince` and `courseAgreement: "no current timeback seat"`, refreshed by one direct call on read once a day. `inSnapshot: false` with `unmatchedReason` (HTTP 404 = no account under this organisation's key; HTTP 401 = another organisation's key; `no email` = nothing to look up by) is a student Math Academy does not know here; retried at every load and once a day on read.
- **The row.** `mathAcademy.currentCourse {id, name, startDate, progress (0–1), xpRemaining, completed, grade, letterGrade, estimatedScore}` is Math Academy's own record as of `figuresAsOf` (`figuresBasis` says bulk list, which can lag a day, or a direct call). `mathAcademyState` reads it: `not started` (progress 0; say "not started in <course>", never "0 XP left"; `xpRemainingReading` on every row says how to read the XP figure, print it instead of a bare 0), `in progress`, `at 100, not marked complete` (progress ≥ 0.995), `completed` (Math Academy closed the course: usually at the last lesson, but seen at 69, 81 and even 0 percent: a course switch, or an early close by an administrator (two students have sat fifteen months at 69 percent and at 81 percent with the flag and no move), not decidable here, so read `progress` beside it). `timeback.currentMathAcademySeats[]` is live; `courseAgreement` compares (vocabulary in A7). `isLikelyTest` is the test-account judgement.
- **Two quirks of Math Academy's own figures.** `xpRemaining` is recomputed on Math Academy's schedule, not per task (it has stayed put while `progress` moved), and it reads 0 at progress 0.97 on some students and on SAT Math Prep: a 0 beside progress under 0.995 means "unknown, nearly done", never "0 left". **SAT Math Prep** has no progress at all (`progress` null, `estimatedScore` = Math Academy's predicted SAT score): report the score and its date; treat XP left as unknown; the state reads `in progress` whatever the truth, and only `completed` marks a finish there.
- Errors: no token → 401; a token Timeback rejects → 401 `timebackStatus 401`; an id Timeback does not know → 404 `timebackStatus 404` (authentication first, so an unauthenticated caller learns nothing about ids); any other Timeback 4xx passes through; an email matching no or several users → 404 `timebackMatches`.
- Failure mode: quoting a figure without its date; reading `not in snapshot` as "never on Math Academy"; reading a `not started` 0 as finished; quoting `xpRemaining` on SAT Math Prep.

Output shape: `user.sourcedId`, `snapshotAt`, `figuresAsOf`, `stale`, `matchedBy`, `mathAcademyState`, `maCourse (name)`, `maCourseStart`, `progress`, `xpRemaining`, `grade`, `letterGrade`, `estimatedScore (SAT Math Prep only)`, `completed`, `deactivated`, `timebackCourseSourcedId(s)`, `courseAgreement`, `isLikelyTest`.

VERIFIED RUN (twelve independent cold runs, 2026-09-17 and 2026-09-18): `courseAgreement` and `mathAcademyState` reproduced from live seats and the served figures on every stratified row checked (30/30, 30/30, 23/23); the gate returned byte-identical 401s for existing and non-existing ids without a token; per-student rows answer in about a second.

### A2 · A student's tasks and days — "What did she do, how long, how well?"

```
GET <front base>/store/student/<sid>/activity?from=<YYYY-MM-DD>&to=<YYYY-MM-DD>     # America/Chicago days, both optional, 400 if malformed or reversed
      # tasks[]: Math Academy's own record per task: taskId, type (Lesson | Review | Quiz | Multistep | Placement | Exam | Supplemental), courseId/courseName (the course Math Academy ran the task in),
      #          topicId/topicName, xp (nominal), xpAwarded (what the student got), questions, questionsCorrect, startedEpochMs, completedEpochMs, timeElapsedMs, timeEngagedMs, timeProductiveMs
      # days[]: the day's totals over those tasks, same clock names, milliseconds; windowUtc = the Chicago day as a UTC window
      # coverage {backfilledAt, backfilledFrom}, daysRequested[] (a status per day when from and to span 90 days or fewer), reasonIfEmpty, activityLastDate
```

- **Everything is milliseconds**; divide by 60,000 for minutes. `xpAwarded` is signed: negative = Math Academy's rushing/guessing penalty, zero = failed without penalty, positive = credited. Sum `xpAwarded`, never `xp`.
- **Per day, report:** tasks, XP awarded, engaged / elapsed / productive minutes, `productive ÷ engaged` and `engaged ÷ elapsed`, the task mix by type. **Over a week or more, add the habits block** (§ How to work): minutes per XP with its clock named ("store engaged"), the negative-XP share and the zero-XP share over lessons only, and the lesson count. On a day of two or three tasks, name the task that dominates a ratio (a single review is seconds long).
- **Which days exist.** With `coverage.backfilledAt` set, an absent day between `backfilledFrom` and the day before `activityLastDate` is a day with no Math Academy task; the `activityLastDate` day reads "no row yet" when absent (late Timeback rows; re-pulled tonight); later days are not pulled yet; the current day holds nothing in the store until tonight's pull (Part B2 for today). `daysRequested[]` carries exactly these statuses. A `days[]` row with `error` means Math Academy refused that student's activity (status inside).
- **First ask backfills.** If `coverage.backfilledAt` is unset the route pulls the student's whole activity from 2025-07-01 on this read (about five Math Academy calls, once; `backfilledNow` says what was pulled) and serves it. Since the batch of 2026-09-18 this is rare (a student seated for the first time since).
- **Timeback's copy** (B2, B3) is the same tasks: join by `taskId` (a number here, a string inside Timeback's URL), never by date (Timeback's `scoreDate` is UTC; a 19:14 Chicago task is the next UTC day there). Timeback's `metadata.xp` equals `xpAwarded`; Timeback's `activeSeconds` equals `timeEngagedMs` to within two seconds on tasks that sent a time row; Timeback never sees elapsed or productive time. The store can hold tasks Timeback never received (a per-student Caliper gap: 94 of one student's 182 SAT Math Prep tasks), and Timeback holds a handful of XP-adjustment rows that are not tasks (B1).
- Failure mode: treating a day with no `days[]` row as zero work; reading a clock as seconds; computing "engaged share" from Timeback's minutes (100 percent by construction); merging negative and zero XP; quoting the current day as complete.

Output shape: per day — `date`, `numTasks`, `xpAwarded`, `elapsedMin`, `engagedMin`, `productiveMin`, `productiveShare`, `engagedShare`, `byType`; per window — `lessons`, `minutesPerXp {value | "no pace", clock, window}`, `negativeXpShare`, `zeroXpShare`, `daysWorked`, `longestGapDays`; per task when asked — `completedAt (UTC)`, `localDay`, `type`, `courseName`, `topicName`, `xpAwarded`, `correct/total`, `engagedMin`.

VERIFIED RUN (2026-09-17 and 2026-09-18, twelve cold runs): every task present on both sides matched on id, XP and Chicago day (32,847 of 32,847 joined tasks over a month, estate-wide, in the largest run); the two one-sided sets are the documented ones (store-only: tasks Timeback never received; Timeback-only: late rows of the newest day, students with no Math Academy record, and one deactivated account whose Timeback events the backfill never saw); `days[]` totals equalled their tasks on every day row; EduBridge's minutes equalled the engaged clock wherever every task had a time row and fell short where some did not.

### A3 · Current course and progress — "What course is she in and how far along?"

```
GET <front base>/store/student/<sid>?minimal=1        # Math Academy's course, progress, xpRemaining, grade, completed, estimatedScore; timeback.currentMathAcademySeats live; courseAgreement
```

- The answer is the row (A1): Math Academy's `currentCourse.name`, `progress` as a percent, `xpRemaining` with its date, `grade`/`letterGrade`, and the Timeback seat(s) beside it with `courseAgreement`. Add the habits block from A2 over the last 14 days when asked "how is she doing".
- **Two seats:** `courseAgreement` is `agree` if Math Academy's course matches any current seat; report both seats (invariant 5).
- **Do not estimate what you can read.** The Timeback-only estimate of XP remaining (course size × (1 − percent), B4) exists for readers without store access; against Math Academy's own figure it has run from 64 percent too high to 67 percent too low. When the store has the student, the estimate is not a number to publish.
- Failure mode: reporting Timeback's rounded percent as progress when Math Academy's `progress` is on the same row; taking `xpRemaining` 0 at progress under 0.995 as done; quoting anything on SAT Math Prep but the score.

Output shape: `maCourse`, `progressPct`, `xpRemaining (or "unknown, nearly done" | "unknown: SAT Math Prep")`, `estimatedScore (SAT Math Prep)`, `grade`, `letterGrade`, `completed`, `figuresAsOf`, `timebackSeats[] {courseSourcedId, courseName, beginDate}`, `courseAgreement`, plus the habits block.

VERIFIED RUN (2026-09-18, four cold runs): progress on the row sat within a point or two of Timeback's newest percent for the same course on every student checked (the bulk list can lag a day; a fresher Timeback percent is the newer figure, not a contradiction); the fallback estimate, computed beside it for comparison, sat inside the stated band and usually low.

### A4 · A class this week — active, quiet, and why

```
A. GET <front base>/store/course/<course.sourcedId>/students        # the roster at rosterReadAt: one row per roster student with isLikelyTest, classSourcedIds[] (section), seatBeginDates[], currentSeatCount, grades[],
      #   mathAcademyState, mathAcademyCourseId/Name, progress, xpRemaining, completed, courseAgreementAtSnapshot, matchedBy; count, nonTestCount; ?agreement=<value> filters
B. for each Chicago day in the window (up to activityLastDate): GET <front base>/store/course/<course.sourcedId>/activity?date=<YYYY-MM-DD>
      #   one row per roster student with a pulled day: numTasks, xpAwarded, the three clocks, questions, questionsCorrect, byType {Lesson, Review, ...}, lessons, lessonsNegative, lessonsZero; totals (the same fields summed, byType merged); coverage {studentsBackfilled, studentsNotBackfilled}; dayStatus; pulledAt
      #   the class's task mix, minutes per XP and the two lesson shares come from these rows and totals: NO per-student loop is needed for a class picture (one call per course-day)
      #   active = the union of rows' sourcedIds over the days; quiet = nonTest roster − active
C. for each quiet student: GET <front base>/store/student/<sid>/courses        # free: Math Academy's own course episodes, lastTaskAt, lastLessonAt (their last Math Academy task ever, any course)
```

- **The roster is the store's list at `rosterReadAt`, that is TODAY's roster, whatever day you ask about.** The course-day route counts today's members on every past day (`rosterAsOf` on the response): a student who left the course since is not counted, a student who joined since is counted with work they did in another course. For this week that is what a guide wants; for a past month it is not (August figures for one course came out 16 to 20 percent off): then take each student's `/activity` rows and keep the tasks whose Math Academy `courseId` is the course (A9's attribution), or Timeback's filed view (B7). Students who left the course are found through `/store/finishers` (finished) or B7 (moved). The list is section by section via `classSourcedIds`; filter to your section there (a section's title, school and status come from Timeback's `classes/{id}`; on the big grade courses one automanaged section holds nearly every real student and the other sections are near-empty, so "the section" is often the course). Only if you need seats created since the last load read Timeback's enrollments (B5 A–B). Course ids come from `reference/timeback-math-academy-courses.json`; "the course" is every section.
- **Active means "did a Math Academy task"**, in any Math Academy course, because the store's day rows are Math Academy's own record for roster members. A student whose Timeback events are filed under another course is still active here; whether the filing is right is A7's question.
- Active students (a store day in the window) need no kind: report them as **active** with their week's figures. **Sort each quiet student into exactly one kind, testing in this order**, and report the seat's age (`seatBeginDates`) beside it:
  1. **wrong course**: `courseAgreementAtSnapshot` `disagree` (Math Academy runs them elsewhere; a roster defect to report, not disengagement); `disagree, math academy course completed` is its own case: **finished another course, seated here, not started here** (Math Academy still shows the finished course; ask for the Math Academy-side move, A5);
  2. **no Math Academy record**: `no math academy record` (with `unmatchedReason`);
  3. **Math Academy has progress, Timeback has nothing**: `progress` above 0, `/courses` shows an episode, and no Timeback result ever (one Timeback read, B2, per CANDIDATE only: candidates are quiet students with progress above 0 whose `/courses` episodes exist; four of 191 quiet Prealgebra students on 2026-09-18; ticket 23);
  4. **finished, not quiet**: `mathAcademyState` `completed` or `at 100, not marked complete` for this course: route to A5;
  5. **new**: `seatBeginDates` inside the window (read `startDate` on the row too: a Math Academy `startDate` inside the window with progress already well above 0 is a student Math Academy moved into this course with prior credit, not this week's work; 27 of 45 in one 8th-grade class);
  6. **placed weeks ago, never started this course**: `not started` and the seat older than two weeks. A real finding: 114 real students estate-wide on 2026-09-17, some seated over 150 days;
  7. **stopped**: episodes exist (`/courses`), `lastTaskAt` before the window; give the last date and the store's progress;
  8. **deactivated Math Academy account** (`deactivated: true` on the row): the store's pull can be empty while Timeback holds the work; read Timeback (B2) before any other kind;
  9. **never any task at all**: `/courses` empty, `deactivated` false, and the seat older than the window.
  A Math Raiders, hole-filling or TEKS Math seat beside a current Math Academy seat says nothing (most active students hold one). "Moved on within math" is a disposition for a student with no current Math Academy seat (A5), never a reason to drop a quiet student who still has one.
- **Class totals** (B's `totals`) are by roster membership and cover `studentsBackfilled` of `studentsWithStoreRow`; read `coverage` and `dayStatus` before quoting a total, and say "as of `pulledAt`" for the newest day (late Timeback rows land on tonight's re-pull; the current day holds nothing in the store until tonight's pull; read Timeback for today, Part B7).
- Failure mode: taking one section as the course; counting test accounts (use `isLikelyTest`); handing a lead a quiet list with finished and wrong-course students still on it; quoting the newest day as complete.

Output shape: per course — `rosterNonTest`, `active`, `quiet`, `tasks`, `xpAwarded`, `engagedMin`, `productiveMin`, `minutesPerXp` with the task mix (from `totals.byType`), `negativeXpShare` = `totals.lessonsNegative` over `totals.lessons`, `zeroXpShare` = `totals.lessonsZero` over `totals.lessons`, by day (all from the course-day route; the per-student `/activity` loop is for per-student write-ups only); per quiet student — `user.sourcedId`, `section`, `seatBeginDate`, `seatAgeDays`, `kind`, `lastMathAcademyTaskEver` (from `/courses` for every kind, null when there is no episode), `storeState`, `courseAgreementAtSnapshot`. No names.

VERIFIED RUN (2026-09-17 and 2026-09-18, five cold runs): the store's roster equalled an independent Timeback enrollment read on every course checked (nine courses, identical id sets); the store's day rows equalled Timeback's results per student on every pulled day where Timeback had ingested the day (e.g. 96 = 96 and 17 = 17 active students in a week; 328/328 task ids on the six most active students), and where they differed the store held MORE: Timeback missed whole days for some students (47 tasks of 1 and 2 September 2026 across seven students never arrived), so join by task id when a Timeback figure matters; the ordered kinds were applied to 191 quiet students in one course.

### A5 · Who finished — Math Academy's own flag first

```
A. GET <front base>/store/finishers?since=<YYYY-MM-DD>[&mathAcademyCourseId=<id>]      # every store row (roster or not) whose CURRENT Math Academy course carries completed >= since, sits at >= 0.995, or (no seat) sits at 0.95 to 0.994; a few seconds
      #   counts: count / nonTestCount = ALL rows incl. the near-finisher bucket; finishedCount / finishedNonTestCount = completed + at-100 buckets; workedThroughNonTestCount also drops likely placement pass-throughs; byBucket
      #   rows: sourcedId, bucket, mathAcademyCourseId/Name, completed, startDate, daysInCourse (or startAfterCompleted when Math Academy re-dated the course), progress, xpRemaining, mathAcademyState, tasksInCourse, lessonsInCourse, passThrough (set when a completed row has under 20 lessons in the finished course: the real finish is the previous episode in /courses), courseAgreementAtSnapshot, timebackCourseSourcedIds[], offRosterSince, isLikelyTest, matchedBy, figuresAsOf
      #   quote finishedNonTestCount or workedThroughNonTestCount as "finishers", never count
B. for finishers still on a roster: GET <front base>/store/student/<sid>/history          # course changes and the old course's completed date, one row per night since 2026-09-17 (off-roster students gain history rows from the load of 2026-09-19 on, planned; before that their history holds only the nights they were seated, often none)
C. for the disposition, ONLY when the row's timebackCourseSourcedIds[] is empty (a non-empty list already says re-seated or parked): GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>'&limit=3000      # Timeback: every seat, any status; keep course.name starting 'Math Academy' for the math seats;
      #   classify the rest by KIND without quoting titles (TEKS Math course, hole-filling, Math Raiders, custom plan): per-student titles carry the child's name
```

- **Finished = Math Academy says so.** `completed` set with `progress` at or near 1, or `at 100, not marked complete`. Report `progress` beside every completion date: Math Academy has set `completed` at 69, 81 and even 0 percent (a course switch, or an early administrative close that then sits for months), and those are not finishes. `completed` is usually stamped at the student's last lesson, seconds after it.
- **Who is in A.** Every student who ever held a seat has a store row (the backfill matched them), so finishers who have already left the Math Academy roster ARE here as long as Math Academy still shows the finished course as their current one: `timebackCourseSourcedIds []` with `offRosterSince` set. **Who is not:** a student Math Academy has already moved to a new course; their finished course's `completed` date is gone from the current record. For those, B's `/history` keeps the old course's last row (with `completed` if a night saw it) from 2026-09-17 on for roster students and from 2026-09-19 on for students who left the roster (before that an off-roster student's history holds only the nights they were still seated, often none); for finishes before that only Timeback's rounded 100 remains (B6), and on 2026-09-18 that was between a quarter and two fifths of the finishers since 1 August (36 of 137 in one run, 63 of 148 in another), so **for a complete count of finishers over a window that predates the store, run A and B6 and union them**, and say which source dated each finish. Two more readings of A's rows: `bucket` "left the roster near the end, not finished" (progress 0.95 to 0.994, no seat: Timeback's rounded 100 progressed them out before Math Academy closed the course; seven such students on 2026-09-18) and a `completed` with `daysInCourse` of a few days and a small episode in `/courses` (a placement pass-through into a course below the one just finished: the real finish is the previous episode). A Timeback 100 with Math Academy under 0.9 and no flag is an incoherence to report, not a finish.
- **Disposition** from the newest-begun current Math Academy seat in C: **advanced to <course>** (and `courseAgreementAtSnapshot` `disagree, math academy course completed` = Timeback advanced them while Math Academy still shows the old course: ask for the Math Academy-side move; whether the new seat is the right course is open question #7); **re-seated in the finished course**; **no current Math Academy seat but current math work of another kind** (a TEKS Math course, hole-filling, Math Raiders, a supplement) = **moved on within math, the normal outcome of progression, never a flag**; **no current math work of any kind** (rare; finishers from the last two or three days may not be processed yet).
- **SAT Math Prep:** only `completed` marks a finish (progress is null there; Timeback's percent has no known meaning on that course, ticket 22), and there `completed` has landed a day after the last task and students have kept working after it, so "seconds after the last lesson" does not hold on that course. `since` defaults to all time when omitted (Math Academy has stamped `completed` dates back to 2025, so an omitted `since` returns hundreds of rows; pass the window you mean); the at-100 and near-finisher buckets are served whatever the date, because they carry none.
- Failure mode: calling `completed` at 70 percent a finish; treating a student who moved on within math as lost; reading Timeback's 100 as a finish without Math Academy's flag or a last-lesson date; missing the finishers Math Academy has already moved (say so, and use B6 when the window predates the store).

Output shape: `user.sourcedId`, `finishedMathAcademyCourse`, `completed (date) | at 100`, `progress`, `datedBy: math academy completed | history | timeback 100`, `disposition`, `courseAgreementAtSnapshot`, `offRosterSince`.

VERIFIED RUN (2026-09-18): the route lists Math Academy's completed flags across the whole store in one call; cold runs on 2026-09-17/18 confirmed `completed` stamped seconds after the last lesson on every finisher where both were visible, and found progression re-seating finishers within days.

### A6 · Where a student is struggling — "Which topics is he failing, and did he recover?"

```
GET <front base>/store/student/<sid>/activity?from=<date>&to=<date>      # tasks[] with Math Academy's own topicId/topicName and type
GET <front base>/store/student/<sid>/knowledge                            # one live Math Academy call on first ask (A10); cached 7 days
```

- Group lessons and reviews by `topicId`; group quizzes and multisteps by `topicName` (their topic slot is an instance). Three labels, kept apart: **penalised** = `xpAwarded < 0` (rushing and guessing, a habit), **failed** = `xpAwarded == 0` (no credit, a difficulty), **low accuracy** = `questionsCorrect ÷ questions` below 0.6 (the reader's own reading; it disagrees with Math Academy's verdict on about a tenth of tasks, so never call a quiz "failed" on accuracy alone). Per topic: attempts, `state` = **recovered** (the latest task is credited) | **open** (the latest is not credited: no retry yet) | never failed.
- Shares are over **lessons only** and labelled so (reviews carry most negative and zero XP and would double the share). A failed review of an earlier course's topic is spaced repetition, not a gap in the current course: separate lessons from reviews.
- Carry each weak topic's `stability` from the knowledge map beside it (A10): zeros with a task on record are the topics that just collapsed.
- Failure mode: grouping quizzes by topicId; treating review failures as lesson gaps; calling a topic "not recovered" when it was failed today (that is `open`).

Output shape: one row per topic — `topicId`, `topicName`, `attempts`, `penalised`, `failed`, `lowAccuracy`, `byType`, `lastType`, `lastCompletedAt`, `state`, `stability`; plus the window headline from A2.

VERIFIED RUN (2026-09-17/18, four cold runs): failures clustered by topic family and were mostly re-taught and passed within days; the two struggling students of one run read 62 and 63 percent negative-XP lessons with zero failed lessons, the habit case the two shares are built to separate.

### A7 · Wrong course — "Is anyone in the wrong course?"

```
GET <front base>/store/course/<course.sourcedId>                          # counts by courseAgreementAtSnapshot, with a nonTest block
GET <front base>/store/course/<course.sourcedId>/students?agreement=disagree                                  # the rows
GET <front base>/store/course/<course.sourcedId>/students?agreement=disagree%2C%20math%20academy%20course%20completed   # finished elsewhere, seated here (URL-encode the value; the plain form is shown elsewhere for reading)
```

- `courseAgreement` vocabulary (one rule: normalised name match of Math Academy's course against any current seat, `, math academy course completed` appended when Math Academy has set `completed`): `agree`; `agree, math academy course completed` (both systems still on the finished course: parked); `disagree` (Math Academy runs them in a different course: report the Timeback course id and the Math Academy course name to the platform team; which side is right is not decidable here, open question #7); `disagree, math academy course completed` (Timeback advanced them, Math Academy did not: ask for the Math Academy-side move); `no current timeback seat`; `math academy has no current course`; `no math academy record`; `not in snapshot`.
- `nonTest.byMathAcademyState` counts each student's **current Math Academy course**, so a `completed` under an Algebra I heading can be a Prealgebra finisher seated in Algebra I; finishers of this course who were re-seated are not on its roster (A5).
- Failure mode: treating a `name`-matched row (`matchConfidence: low`) as certain; forgetting that a disagree list can be all test accounts (read `nonTestCount`).

VERIFIED RUN (2026-09-17/18, every cold run): counts summed to the roster on all 22 courses and every `?agreement=` filter returned exactly its bucket; each disagree row's Math Academy course and live seat were reproduced from Timeback.

### A8 · Estate-wide day or week — "How much Math Academy happened yesterday across the school?"

```
for each course.sourcedId in reference/timeback-math-academy-courses.json:
    GET <front base>/store/course/<course.sourcedId>/activity?date=<YYYY-MM-DD>       # rows (roster students with a pulled day), totals {numTasks, xpAwarded, the three clocks, questions, questionsCorrect}, coverage, dayStatus, pulledAt
```

- One free call per Math Academy course per day (22 courses; the reference file also lists a partner course that holds no roster student and answers 404, skip it) gives the estate by Timeback course as TODAY's rosters (`rosterAsOf`; a past day counts today's members, so a month-old day for one course can be 16 to 20 percent off while the estate total is barely moved), students counted by roster membership (a student's work is under the course they SIT in, wherever Math Academy filed it). Drop test accounts with `isLikelyTest`. Quote the day "as of `pulledAt`": 3 to 8 percent of Timeback's rows for a day are ingested after the 03:45 pull and land on the next night's re-pull; `pulledAt` is set only on nightly-pulled days (batch-backfilled days carry a note instead); the current day holds nothing in the store until tonight's 03:45 pull (`dayStatus` says so; Part B7 for today).
- Seatless students (finished and moved on, or filing under a deleted seat) are not on any roster and so not in these totals; `GET /store` `lastActivityRun.students` counts every student pulled for the day, roster or not, EXCLUDING roster students whose Timeback rows all arrived after the pull and students without a Math Academy id, so seatless = `lastActivityRun.students` minus the day's roster rows (17 on 2026-09-17), never Timeback's active students minus `lastActivityRun.students`. `source` on the course-day response says whether the day came from the nightly pull or the backfill batch.
- The **Timeback-filed** view (which Timeback course each event landed under, including deleted seats and students with no seat) is B7.

Output shape: one row per course — `courseSourcedId`, `courseName`, `rosterNonTest`, `activeStudents`, `tasks`, `xpAwarded`, `engagedMin`, `productiveMin`, `minutesPerXp`; plus `pulledAt`, `dayStatus`.

VERIFIED RUN (2026-09-18, two cold runs): course-day totals equalled the sum of their rows on every field and equalled Timeback's per-student results for the same roster students on every pulled day checked (four courses, six days).

### A9 · A student's whole Math Academy story

```
A. GET <front base>/store/student/<sid>/courses        # Math Academy's own course episodes from the task record since 2025-07-01: per course firstTaskAt, lastTaskAt, tasks, lessons, lastLessonAt, xpAwarded, byType
B. GET <front base>/store/student/<sid>/history        # nightly course figures since 2026-09-17: course changes, the old course's completed date
C. GET <front base>/store/student/<sid>                # the current record
D. GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>'&limit=3000      # Timeback: every Math Academy seat ever (course.name starts 'Math Academy'), status, beginDate, endDate (absent when open), dateLastModified
```

- **Episodes are Math Academy's attribution**, independent of Timeback seats: one episode per course Math Academy ran the student in, ordered by first task. An episode ending and the next beginning is a course change; `lastLessonAt` is the date Math Academy usually stamps `completed` at; a short episode followed by a new course can be a switch (read `progress`/`completed` in B and C), not a finish.
- **Seats are Timeback's half.** Lay D beside A: a seat begun the day an episode began, a seat still `active` for a course whose episode ended months ago (a stale seat), an episode with no seat at all (Math Academy ran a course Timeback never seated: a roster question for the platform team; seen twice in cold runs), a `tobedeleted` seat whose `dateLastModified` is the day the episode's percent touched 100 (progression). A deleted seat carries no `endDate`; `dateLastModified` is the closest proxy for when it closed.
- Gaps that matter are task gaps (`/activity` days) and seatless windows, not gaps between seats.
- Which **Timeback course each event was filed under** (often a deleted seat, sometimes a course never held) is B9; it matters only for Timeback-side hygiene.
- Failure mode: assuming one seat per course; reading `primary`; dating "finished" from an episode's end alone; quoting non-Math Academy course titles from D.

Output shape: one row per episode — `mathAcademyCourse`, `firstTaskAt`, `lastTaskAt`, `lastLessonAt`, `tasks`, `lessons`, `xpAwarded`, `seat {status, beginDate, dateLastModified} | none`, `finish {completed | at 100 | switch | open}`; plus `seatlessWindows[]`, `taskGapsOver7Days[]`, `current {course, progress, completed, courseAgreement}`.

VERIFIED RUN (2026-09-18): episodes from the backfilled rows reconciled with Timeback's results by task id on every student checked (five students, 138 to 1,356 tasks each) and exposed two course episodes with no Timeback seat and one seat with no episode.

### A10 · The knowledge map — "What does this student actually know?"

```
GET <front base>/store/student/<sid>/knowledge                 # current course; one live Math Academy call on first ask, cached 7 days per courseId
GET <front base>/store/student/<sid>/knowledge?courseId=<mathAcademyCourseId>&refresh=1   # another course of theirs, or force one live call
```

- **Response shape:** `{ sourcedId, courseId (a string), fetchedAt, fromCache, knowledge { courses[], requestedCourse {id, name, completion, indexInCourses, topicCount, note} }, note }`. `courses[]` holds up to two prerequisite courses first and the course asked for last; `courses[].id` is a number; use `requestedCourse.indexInCourses` or match on id, never `courses[0]`. Walk `units[] → modules[] → topics[]`; `stability` (0–1) is Math Academy's estimate of long-term retention.
- **Reading stability.** Exactly 0 = no current retention evidence: untaught topics AND topics just failed both read 0, so split the zeros by the task record (A2): zeros with a task are topics that just collapsed (top of the weakest list); zeros without one are untaught (open question #19). The rule is not symmetric: a topic failed this week can still read 1.0 (two students on 2026-09-18), so rank a weakest list from the task record (A6: open failures first) and use stability to order within it, never to filter it. Low but non-zero on a topic whose only task is a lesson passed a day or two ago is new, not fading. **Placement-credited** topics (non-zero stability, no task on record: the student tested out; a finisher had 116 of 157) and the **floor value** (0.0025 across a whole untouched unit) are not weaknesses. A zero whose only task is an old credited review is a lapse to re-check.
- Errors: 429 = Math Academy's fair-use limit (do not loop); 404 = wrong or never-held `courseId` (`studentCurrentCourseId` on the body; cached a day so a loop does not spend a call per miss); 502 with `mathAcademyStatus` otherwise.
- Failure mode: looping the call; taking `courses[0]`; joining the string `courseId` to numeric ids; dropping the zeros; calling a topic learned yesterday "fading"; quoting the map without `fetchedAt`.

Output shape: per course — `courseId`, `name`, `completion`; per unit — `name`, `stability`, `weakestTopics[] {topicId, name, stability, lastTask {date, type, credited} | null}` ordered zeros-with-a-task first, then lowest non-zero; `untaughtZeros`, `placementCredited`; a headline `topicsBelow(0.5)` with its denominator.

VERIFIED RUN (2026-09-17/18, six cold runs): prerequisite courses first and the requested course last on every read; second reads from cache; `topicCount` equalled the walked topics; a just-failed topic at 0 and freshly learned topics among the lowest non-zero on the first run, which is why the reading rules exist.

### A11 · The estate picture and roster hygiene

```
GET <front base>/store                                   # with your token: counts {timebackRoster, timebackLikelyTest, nonTest {students, byAgreement, byMathAcademyState}, matched, tbUnmatched, maBulk, studentsWithTwoOrMoreSeats, sumsNote}, byCourse
GET <front base>/store/course/<course.sourcedId>/students      # per course: the rows with isLikelyTest, grades[], seatBeginDates[], currentSeatCount, deactivated, courseAgreementAtSnapshot, mathAcademyState
```

- Every count block sums; `byCourse` and the course lists count SEATS (a student with two seats is under both headings and on both lists; `studentsWithTwoOrMoreSeats` says how many), while `counts.nonTest` and `counts.courseAgreement` count STUDENTS, so a bucket can read 15 students on `/store` and 16 rows across the lists. The defect list a platform team can act on, each from list-row fields: **wrong course** (`disagree`), **no Math Academy record** (`unmatchedReason`), **not started in this course, seated 14 days or more** (`not started` + `seatBeginDates` older than 14 days; "never any Math Academy task" is the stricter test, `/courses` empty, and the two differ by students who worked an earlier course or did one placement), **Math Academy progress with no Timeback result** (needs one Timeback read per candidate, B2; ticket 23), **below grade 4** (`grades[]`), **deactivated account with a seat**, **two current seats** (`currentSeatCount` ≥ 2), **real students in the bare `Math Academy` or `Beyond AI` courses** (owner rule; those courses hold only test accounts), **unflagged synthetic accounts** (`isLikelyTest` true with `isTestUser` false). Events filed under a course the student no longer sits in is a Timeback-side defect: B7.
- Failure mode: summing `byCourse.students` as the roster; using `isTestUser` alone; naming students.

VERIFIED RUN (2026-09-18, two cold runs): 22 course blocks summed and reproduced from their lists; the estate roster and non-test totals reproduced from an independent Timeback build on nine courses; on 2026-09-17 the estate held 114 real students seated two weeks or more with no task ever, 22 below grade 4, 15 without a Math Academy record and 73 in a course Math Academy does not run them in.

---

## Part B — Timeback's containers: the roster half, and fallbacks for readers without store access

Use Part B for (1) **today**, before tonight's pull; (2) **which Timeback course an event was filed under** (roster hygiene, progression, the "unenrolled"); (3) a reader whose token cannot reach the store. For everything else Part A is shorter, exact and free. Reading cost on Timeback: about a thousand Math Academy results a day averaged over the calendar, about two thousand on a school day; `limit` caps at 3000, so loop `offset` to `totalCount` (trap 18) and pass `sort=scoreDate&orderBy=asc` on every estate-wide read (ingestion continues while you page).

### B1 · Selecting Math Academy rows, and resolving a person to an id

- **Select by equality, then drop the non-tasks.** Filter `metadata.appName='Math Academy'` on the wire and check it on every row kept (other apps' rows may carry no `appName`; trap 22). Then keep a row only if `metadata.sensor == 'https://mathacademy.com'` AND `metadata.originalObjectId` has a task shape (`/topics/<topicId>/<type>` for lesson, review, quiz, multistep; `/tasks/<taskId>/<type>` for placement, exam, supplemental; trap 7). What falls out are Timeback's own XP bookkeeping rows stamped with the app name: `…/manual-xp-assignment/…` ("Manual XP Assignment - Math", hundreds of XP, no question keys) and `…/tasks/<id>/<date>/correction-rerun` ("Data Correction", several rows sharing one task id); a handful of rows match neither shape. They are adjustments, not work: never tasks, failures or minutes; report their XP on its own line (trap 27; one student carried 1,365 XP of them).
- **A person to an id, once.** `GET /ims/oneroster/rostering/v1p2/users/?filter=email='<email>'` → `users[0].sourcedId`. By name: `filter=givenName='<first>' AND familyName='<last>'&limit=10`; **names collide**: keep the candidate with a `userProfiles` entry of vendorId `math_academy` AND a current Math Academy seat AND Math Academy results; if more than one still qualifies, stop and ask which child. The email or name does not travel further.
- **Fields on a result:** `metadata.xp` (signed XP awarded = the store's `xpAwarded`), `score` (null = zero correct, trap 9), `metadata.totalQuestions`, `metadata.correctQuestions`, `scoreDate` (UTC completion time), `metadata.pctCompleteApp` (an integer percent as a string; absent on about a tenth of rows; on SAT Math Prep its meaning is unknown, ticket 22). `dateLastModified` is ingestion time, sometimes hours or days late: never the activity time.

### B2 · A student's tasks from Timeback (fallback for A2)

```
GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy' AND scoreDate>='<UTC instant>'&sort=scoreDate&orderBy=desc&limit=3000&offset=0
GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<assessmentLineItem.sourcedId>       # title = topic name, course = the Timeback course the event was FILED under (one per row; cache)
```

- Type and topic id from the URL (quiz and multistep slots are instance ids, trap 25); XP signed; the filed course from the line item (per course listing, `assessmentLineItems?filter=course.sourcedId='…' AND dateLastModified>='<from − 7 days>'`, is cheaper than one GET per task). Seconds per task come only from EduBridge's weekly facts (B3) and are the engaged clock, a floor. Bucket by Chicago day from `scoreDate`, never from `dateLastModified`.

### B3 · Daily totals from EduBridge (fallback for A2's `days[]`)

```
GET /edubridge/analytics/activity?studentId=<sid>&startDate=<local midnight as UTC>&endDate=<day after, local midnight as UTC>&timezone=America/Chicago     # factsByApp[<day>].Math["Math Academy"]; facts[<day>].Math mixes apps; date-only bounds are a 422
GET /edubridge/analytics/facts/weekly?studentId=<sid>&weekDate=<any date in the week>&timezone=America/Chicago       # every app's rows for the week; keep app == 'Math Academy'; ActivityEvent (XP, questions) and TimeSpentEvent (activeSeconds, a string) per task; datetime = scoreDate
```

- `activeSeconds` is Math Academy's **engaged** clock and a **floor**: tasks without a time row are missing and they skew long (a day read 36 minutes here against 65 in Math Academy). `wasteSeconds` is always 0 for Math Academy (trap 4). Days absent are days with no activity, not zeros. Join time rows to results on `datetime` or `source`, never on `activityName` (trap 26). Label the result "engaged minutes on tasks that sent a time row, N tasks without one".

### B4 · Progress and XP remaining from Timeback alone (fallback for A3)

```
GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>' AND status='active'&limit=3000      # Math Academy seats with today inside beginDate..endDate (endDate absent when open, trap 2)
GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy'&sort=scoreDate&orderBy=desc&limit=300      # newest row carrying pctCompleteApp WHOSE LINE ITEM IS FILED UNDER THE SEAT'S COURSE (a moved student's newest percent belongs to the old course; an older row under the seat's course may exist)
GET /ims/oneroster/gradebook/v1p2/assessmentLineItems/<that row's line item>      # its course.sourcedId MUST equal the seat's course, else the percent belongs to another course (traps 10, 21): no estimate, flag the seat
GET /ims/oneroster/rostering/v1p2/courses/<course.sourcedId>                     # metadata.metrics.totalXp, read live (trap 11)
```

- Progress = the newest percent filed under the seat's course, dated by its `scoreDate`; the enrollment's `metadata.pctCompleteApp` is a convenience often absent (trap 3). The estimate `totalXp × (1 − pct/100)` (`reference/course-xp-size.json`) has run from **64 percent too high to 67 percent too low** against Math Academy's figure (about thirty students; usually low; wild near the end of a course): serve it only as "a lot / a little / nearly done" with that band named, never as a number. No estimate when the percent belongs to another course, the course has no `totalXp`, no percent exists, or the course is SAT Math Prep. Never read a seat's `metrics.totalXp` as XP earned.

### B5 · Roster and quiet students from Timeback alone (fallback for A4)

```
A. GET /ims/oneroster/rostering/v1p2/classes/?filter=course.sourcedId='<courseId>'&limit=3000                          # every section (trap 1)
B. for each class: GET /ims/oneroster/rostering/v1p2/enrollments/?filter=class.sourcedId='<classId>' AND status='active'&limit=3000    # role student, today inside beginDate..endDate → the roster (never the class students route, trap 20)
C. GET /ims/oneroster/gradebook/v1p2/assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<UTC instant>'&sort=scoreDate&orderBy=asc&limit=3000&offset=0     # one estate-wide paged read; active = distinct student.sourcedId; quiet = roster − active
D. per quiet student: …assessmentResults?filter=student.sourcedId='<sid>' AND metadata.appName='Math Academy'&sort=scoreDate&orderBy=desc&limit=1      # last result ever
```

- C is "active on Math Academy in any course"; "active in THIS course" keeps only results whose line item belongs to the course (B7). Test users: `users/{id}.metadata.isTestUser` is a floor; the store's `isLikelyTest` is the judgement. Active-but-ended enrollments (`endDate` passed) are not current.

### B6 · Finishers from Timeback's rounded 100 (the older half of A5)

```
A. GET …assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<window start>'&sort=scoreDate&orderBy=asc&limit=3000&offset=0     # page the estate; per student the FIRST row at pctCompleteApp "100", and whether a sub-100 row precedes it (else "on or before")
B. per course: GET …assessmentLineItems?filter=course.sourcedId='<courseId>' AND dateLastModified>='<window start − 7 days>'&limit=3000&offset=0     # the FILED course of that row
C. GET /ims/oneroster/rostering/v1p2/enrollments/?filter=user.sourcedId='<sid>'&limit=3000      # disposition, as in A5 C
```

- **Start from results, never from the roster**: progression marks the finished seat `tobedeleted` the moment it advances the student (a roster-first read found 1 finisher, 9 false ones, 87 missed). A Timeback 100 is a rounded integer (Math Academy's 0.995 with XP left), can dip back to 99, and precedes Math Academy's `completed` by anything from seconds to months; without the store's flag report "at 100 in Timeback, not confirmed complete". Never read the percent on SAT Math Prep (ticket 22). Reading the newest percent without its line item gave 9 false hits in 10 (a previous course's 100 under a new seat).

### B7 · The Timeback-filed view — which course each event landed under

```
A. GET …assessmentResults?filter=metadata.appName='Math Academy' AND scoreDate>='<day>T05:00:00Z' AND scoreDate<='<day+1>T04:59:59Z'&sort=scoreDate&orderBy=asc&limit=3000&offset=0
B. per course: GET …assessmentLineItems?filter=course.sourcedId='<courseId>' AND dateLastModified>='<day − 7 days>'&limit=3000&offset=0      # course = the LINE ITEM's course for each result (trap 21); rows not found → one GET per line item, still missing → 'unattributed'
```

- Attribute by line item, never by the student's current enrollment: a quarter of a fortnight's events sat under a course the student no longer sits in (2,416 of 18,257 under Prealgebra alone), some under courses the student **never** held a seat in, and some belong to students with no current seat. Split students into **on the course's current roster** and **filed under it without a current seat**. Ingestion lag is minutes for most rows, hours for some, up to a week for a few (invariant 4): say when you pulled.
- Uses: progression questions (which course id the 100 landed under), the "unenrolled" (events filed under a course with no seat), same-day spill after a re-seat (events on the seat's first day filed under the old course), and the estate day by filed course.

### B8 · Suspect-course heuristic from lesson topics (weak; A7 is the answer)

Build a topic → majority filed course map from a fortnight of estate-wide lesson rows (lessons only; reviews revisit earlier courses; quiz and multistep slots are instance ids); flag a student when ≥ 3 mapped lesson topics since the seat began point ≥ 80 percent at another course. Against the store it scored precision about 1 in 8 and recall about 1 in 5 (adjacent-grade topic sharing, moved students, thin high-school coverage). `reference/topic-course-map.json` is a dated lesson-only snapshot; rebuild it rather than trust it. Use only when the store is `stale` or a student has no row.

### B9 · The filed-course timeline (Timeback half of A9)

The events filed under each Timeback course, including deleted seats and courses never held: results by student (B2) attributed by line item (one GET per distinct line item, or per-course listings inside the window you are asked about). Deleted seats carry no `endDate` and overlap later seats, so grouping results by seat dates misplaces events (17 percent on one student); attribute by line item or use A9's episodes for Math Academy's own attribution. The last **lesson** under a course is the Timeback-side date that has matched Math Academy's completion timestamp.

---

## Cross-system notes

- The Math Academy task id inside Timeback's task URL and the store's `taskId` are the same number: the join key between the two halves. Topic ids match for lessons and reviews only.
- Timeback receives Math Academy's **engaged** clock (as `activeSeconds`) and never its elapsed or productive clocks, XP remaining, estimated SAT score, course grade, completion date, course attribution or per-topic knowledge map. All of those are in this skill's store; only something fresher than last night routes to the Math Academy API.
- Waste and integrity signals for Math Academy sessions live in timeback_analytics' capture estate, not here (trap 4).

### One-off exact figures from Math Academy (outside this skill's wire)

When a reader needs something fresher than last night, one direct call to Math Academy answers it. This is a documented fallback for a single student on demand, not a data path of this skill: do not poll it, do not loop it over a roster, and never store its key in anything this skill serves. It needs a **Math Academy public API key** for the organisation the student belongs to (one per organisation; a student under another organisation's key answers 401 "Not Authorized", a key limit, not an absence). The current API version is `beta10`; its fair-use limit answers `429` with a `Retry-After` header.

```
GET https://mathacademy.com/api/beta10/students/<student email, Math Academy id or username>          Public-API-Key: <the organisation's key>
    # -> student.currentCourse: { id, name, startDate, progress (0-1), xpRemaining, completed, grade, letterGrade, estimatedScore }
GET https://mathacademy.com/api/beta10/students/<id>/activity?startDate=<YYYY-MM-DD>&endDate=<YYYY-MM-DD>     # dates on Math Academy's clock (UTC)
    # -> activity.tasks[]: { id, type, xp, xpAwarded, questions, questionsCorrect, started, completed (epoch ms), course{id,name}, topic{id,name}, analysis{timeElapsed,timeEngaged,timeProductive} }
GET https://mathacademy.com/api/beta10/students/<id>/courses/<mathAcademyCourseId>/knowledge
    # -> courses[] (prerequisites first, the course asked for last): units[] { stability, modules[] { stability, topics[] { id, name, stability } } }
```

- The email Math Academy knows is the login on the student's Timeback `userProfiles` entry (vendorId `math_academy`); usually the Timeback email, not always. Math Academy's API has changed without notice before; read the response shape, do not assume it.

## Improvement loop

File feedback on this skill's own wire, published in the `/skill` front under `feedback`: `POST <feedback.report>` with JSON `{title, body, reporter, kind?}` files a public, attributed ticket and returns its number and URL; every ticket is mirrored daily into a GitHub issue on the repo named in the front (labels `skill-feedback` + `mathacademy_timeback`) and closures there are copied back. `GET <feedback.open>` lists the open items and `?state=closed|all` the rest; `GET <feedback.open>/{number}` shows one ticket with its thread. Titles are capped at 200 characters and bodies at 10,000. A report shaped `From: / Problem (dated evidence): / Ask: / Acceptance (a falsifiable test the fix must pass):` graduates straight into an eval case. Evidence in a ticket is a class, a field, a rule, or the query that measures it; never a student's name, contact, or an identifying row. A question this pair cannot answer, or a report unacted on, is this skill failing its contract; say so.

Standing open items, each a ticket on this wire: **#7** (which course ids progression honours), **#8** (Math Academy student id in Timeback), **#9** (null scores), **#10** (retention), **#11** (duplicate time rows), **#19** (knowledge stability 0), **#20** (Math Academy's pass rule and 0-XP rows), **#21** (stability without a task on record), **#22** (`pctCompleteApp` on SAT Math Prep), **#23** (Math Academy progress with no Timeback result), **#24** (when `completed` is set), **#51** (repeated progress values on the bulk list).
