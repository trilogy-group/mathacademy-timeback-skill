// mathacademy_timeback front — AWS Lambda (Node.js 20, function URL, payload format 2.0).
//   GET /  |  /skill                                  -> skill.json
//   GET /DICTIONARY.md | /ENABLEMENT.md | /reference/<file>.json   -> bundled files + X-Doc-SHA256 / X-Doc-Version
//   GET /feedback[?state=open|closed|all]              -> plain JSON array: this skill's tickets (its own tracker, a DynamoDB table)
//   GET /feedback/{n}                                  -> one ticket with its thread
//   POST /feedback {title, body, reporter, kind?}      -> 201 {number, url}  (no credential)
//   POST /feedback/{n}/admin {state?, githubUrl?, comment?}  with header x-admin-key -> 200  (the GitHub mirror job uses this)
//   GET /store                                         -> snapshot status: snapshotAt, counts, calls (no student values)
//   GET /store/student/{timeback user sourcedId}       -> that student's Math Academy record from the snapshot + live Timeback seats + agreement
//   GET /store/student?email=<email>                   -> same, resolved to a sourcedId first
//     both with Authorization: Bearer <the READER's Timeback token>; the function replays it against Timeback (GET users/{sid},
//     GET enrollments) and serves the row only if Timeback answers 200 for that student under that token. No Math Academy call is made here.
// Env: TABLE, STORE_TABLE, TB_BASE, SOURCE, GIT_VERSION, ADMIN_KEY, MIRROR_REPO (owner/name, informational).
import { readFileSync, existsSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand, QueryCommand, BatchGetItemCommand } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const CAPS = { title: 200, body: 10000 };
const SOURCE = process.env.SOURCE || "mathacademy_timeback";
const LABELS = ["skill-feedback", SOURCE];
const PUBLIC = process.env.LAMBDA_TASK_ROOT ? `${process.env.LAMBDA_TASK_ROOT}/public` : "./public";
const ddb = new DynamoDBClient({});
const T = process.env.TABLE;
const ST = process.env.STORE_TABLE || "mathacademy-timeback-skill-store";
const TB = (process.env.TB_BASE || "https://api.alpha-1edtech.ai").replace(/\/+$/, "");

// ---- snapshot store -------------------------------------------------------------------------------------
const normCourse = s => (s || "").toLowerCase().trim().replace(/^math academy\s*-\s*/, "").replace(/\s+class$/, "").replace(/\s+math$/, "").replace(/^(\d+)(st|nd|rd|th)\s+grade$/, "$1th grade");
async function tbGet(path, token) {
  const r = await fetch(TB + path, { headers: { authorization: token, accept: "application/json" } });
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}
async function storeMeta() {
  let r; try { r = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("meta"), sk: S("snapshot") } })); } catch { return null; }
  if (!r.Item) return null;
  const snapshotAt = r.Item.snapshotAt?.S; const staleAfterDays = Number(r.Item.staleAfterDays?.N || 7);
  const ageHours = snapshotAt ? Math.round((Date.now() - Date.parse(snapshotAt)) / 36e5) : null;
  const history = JSON.parse(r.Item.history?.S || "[]").map(h => typeof h === "string" ? { at: h, source: "manual" } : h);
  const scheduled = history.filter(h => h.source === "schedule").length;
  // next 03:00 America/Chicago as UTC (CDT = UTC-5; CST = UTC-6). Approximate DST by month.
  const now = new Date();
  const chicagoOffsetHours = d => { const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" }).formatToParts(d).find(x => x.type === "timeZoneName").value; const m = /GMT([+-]\d+)/.exec(p); return m ? -Number(m[1]) : 6; };
  let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3 + chicagoOffsetHours(now), 0, 0)); if (next <= now) next = new Date(next.getTime() + 864e5);
  return { snapshotAt, rosterReadAt: r.Item.rosterReadAt?.S || snapshotAt, snapshotAgeHours: ageHours, staleAfterDays, stale: ageHours !== null && ageHours > staleAfterDays * 24,
    schedule: { snapshot: "03:00 America/Chicago daily", activity: "03:45 America/Chicago daily, for the previous America/Chicago day", nextSnapshotDueUtc: next.toISOString(), scheduledRunsSoFar: scheduled, manualRunsSoFar: history.length - scheduled, firstScheduledRunHasHappened: scheduled > 0 },
    activityLastDate: r.Item.activityLastDate?.S || null, lastActivityRun: r.Item.lastActivityRun?.S ? JSON.parse(r.Item.lastActivityRun.S) : null,
    nightly: r.Item.nightly?.BOOL ?? false, apiVersion: r.Item.apiVersion?.S, history,
    snapshotCalls: JSON.parse(r.Item.calls?.S || "{}"), readCalls: { maLookupOnMiss: num(r.Item.readMaLookup) || 0, maKnowledge: num(r.Item.readMaKnowledge) || 0 },
    counts: JSON.parse(r.Item.counts?.S || "{}"), byCourse: JSON.parse(r.Item.byCourse?.S || "{}") };
}
async function bumpRead(field) { try { await ddb.send(new UpdateItemCommand({ TableName: ST, Key: { pk: S("meta"), sk: S("snapshot") }, UpdateExpression: "ADD #f :one", ExpressionAttributeNames: { "#f": field }, ExpressionAttributeValues: { ":one": N(1) } })); } catch (e) { console.log("bumpRead failed", field, e?.name, e?.message); } }
const sm = new SecretsManagerClient({});
let MA_KEY_CACHE = null;
async function maKey() {
  if (MA_KEY_CACHE) return MA_KEY_CACHE;
  if (!process.env.SECRET_NAME) return null;
  try { const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME })); MA_KEY_CACHE = JSON.parse(r.SecretString || "{}").MA_API_KEY || null; } catch { MA_KEY_CACHE = null; }
  return MA_KEY_CACHE;
}
async function maGet(path) {
  const key = await maKey(); if (!key) return { status: 0, body: null, error: "no Math Academy key configured for the front" };
  const r = await fetch("https://mathacademy.com/api/beta10" + path, { headers: { "Public-API-Key": key, accept: "application/json" } });
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}
async function queryAll(pk, extra = {}) {
  const out = []; let key;
  do {
    const r = await ddb.send(new QueryCommand({ TableName: ST, KeyConditionExpression: "pk = :p" + (extra.cond || ""), ExpressionAttributeValues: { ":p": S(pk), ...(extra.vals || {}) }, ExclusiveStartKey: key }));
    out.push(...(r.Items || [])); key = r.LastEvaluatedKey;
  } while (key);
  return out;
}
const num = v => v?.N !== undefined ? Number(v.N) : null;
const unmarshalFlat = it => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, v.S !== undefined ? v.S : v.N !== undefined ? Number(v.N) : v.BOOL !== undefined ? v.BOOL : null]));
const maState = cc => !cc ? null : cc.completed ? "completed" : (cc.progress === null || cc.progress === undefined) ? "in progress" : cc.progress >= 0.995 ? "at 100, not marked complete" : cc.progress === 0 ? "not started" : "in progress";
const AGREEMENT_VALUES = ["agree", "agree, math academy course completed", "disagree", "disagree, math academy course completed", "no current timeback seat", "math academy has no current course", "no math academy record", "not in snapshot"];
const agreementOf = (ma, seats) => { const name = ma?.currentCourse?.name; if (!name) return "math academy has no current course"; if (!seats.length) return "no current timeback seat"; const done = !!ma.currentCourse?.completed; return seats.some(s => normCourse(s.courseName) === normCourse(name)) ? (done ? "agree, math academy course completed" : "agree") : (done ? "disagree, math academy course completed" : "disagree"); };
const stripPii = ma => { if (!ma) return ma; const { username, firstName, lastName, league, schedule, ...rest } = ma; return rest; };
const STATUS_NOTES = {
  refresh: "nightly: snapshot at 03:00 America/Chicago (bulk list + roster + match), activity pull at 03:45 for the previous local day; history lists every snapshotAt ever loaded; a student missing from the snapshot is looked up live once when first asked for.",
  staleness: "stale is true once snapshotAgeHours exceeds staleAfterDays*24 (2 days once nightly runs; a missed night shows here first); past that, quote mathAcademy figures only with their date and prefer Timeback's live containers (ENABLEMENT ex. 3) for progress.",
  snapshotCalls: "what the last snapshot run cost: timeback GETs, Math Academy bulk pages, Math Academy per-student lookups (it does not include the activity pull or read-time calls).",
  lastActivityRun: "the last finished activity pull: its day, students, done, errors, students without a Math Academy id, Math Academy calls, the UTC window used, finishedAt.",
  readCalls: "estate-wide (all readers) count of Math Academy calls this front has made on readers' behalf since the store began: live lookups on a miss and knowledge-map fetches. Reads are NOT free of Math Academy calls: a miss costs one, a knowledge map costs one per course id per 7 days. /activity, /history and the course routes never reach Math Academy and may be looped.",
  range: "the store holds every student with a current in-window Math Academy seat at rosterReadAt, plus students added by a live lookup (asked for by a reader, or active on a day the activity pull ran); a student progression has moved out of Math Academy, or left seatless, is otherwise absent (courseAgreement 'not in snapshot').",
  schedule: "the two EventBridge schedules and the next snapshot due; firstScheduledRunHasHappened is false until the first 03:00 run lands (history[].source says schedule or manual).",
  counts: "counts.courseAgreement uses the same vocabulary as the rows (agree | disagree | disagree, math academy course completed | no math academy record); byCourse breaks the roster down by Timeback course sourcedId with test users counted separately; no student values anywhere here.",
};
async function storeStudent(event, q, sidFromPath) {
  const token = event.headers?.authorization || event.headers?.Authorization || "";
  if (!/^Bearer\s+\S+/i.test(token)) return resp(401, { error: "send the reader's Timeback token as Authorization: Bearer <token>; this route serves a student only after Timeback answers 200 for that student under that token" });
  let sid = sidFromPath || null;
  if (!sid && q.email) {
    const u = await tbGet(`/ims/oneroster/rostering/v1p2/users/?filter=${encodeURIComponent(`email='${q.email}'`)}&limit=2`, token);
    if (u.status !== 200) return resp(u.status === 401 || u.status === 403 ? u.status : 502, { error: "Timeback did not accept the token for the users lookup", timebackStatus: u.status });
    const users = u.body?.users || [];
    if (users.length !== 1) return resp(404, { error: users.length ? "email matches more than one Timeback user" : "no Timeback user with that email under this token", timebackMatches: users.length });
    sid = users[0].sourcedId;
  }
  if (!sid) return resp(400, { error: "give /store/student/{sourcedId} or /store/student?email=" });
  const gate = await tbGet(`/ims/oneroster/rostering/v1p2/users/${encodeURIComponent(sid)}`, token);
  if (gate.status !== 200) return resp(gate.status >= 400 && gate.status < 500 ? gate.status : 502, { error: "Timeback did not answer 200 for this student under the presented token; nothing served", timebackStatus: gate.status });
  const meta = await storeMeta();
  if (!meta) return resp(503, { error: "no snapshot loaded in the store yet" });
  const minimal = q.minimal === "1" || q.fields === "minimal";
  const row = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) } }));
  const enr = await tbGet(`/ims/oneroster/rostering/v1p2/enrollments/?filter=${encodeURIComponent(`user.sourcedId='${sid}' AND status='active'`)}&limit=3000`, token);
  const today = new Date().toISOString().slice(0, 10);
  const seats = (enr.body?.enrollments || []).filter(e => /^math academy/i.test(e.course?.name || "") && (!e.beginDate || e.beginDate.slice(0, 10) <= today) && (!e.endDate || e.endDate.slice(0, 10) >= today))
    .map(e => ({ enrollmentSourcedId: e.sourcedId, courseSourcedId: e.course?.sourcedId, courseName: e.course?.name, classSourcedId: e.class?.sourcedId, beginDate: e.beginDate, endDate: e.endDate, pctCompleteApp: e.metadata?.pctCompleteApp ?? null }));
  const base = { sourcedId: sid, snapshotAt: meta.snapshotAt, rosterReadAt: meta.rosterReadAt, snapshotAgeHours: meta.snapshotAgeHours, staleAfterDays: meta.staleAfterDays, stale: meta.stale, apiVersion: meta.apiVersion, timeback: { currentMathAcademySeats: seats, readAt: new Date().toISOString(), enrollmentsStatus: enr.status } };
  if (!row.Item) {
    const un = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("tb_unmatched"), sk: S(sid) } }));
    // live Math Academy lookup on a miss: once per 24 h per student, keyed on the Timeback email the reader is already entitled to see
    const lastTried = un.Item?.lastTriedAt?.S ? Date.parse(un.Item.lastTriedAt.S) : 0;
    const email = gate.body?.user?.email;
    if (email && Date.now() - lastTried > 864e5 && (await maKey())) {
      const live = await maGet(`/students/${encodeURIComponent(email)}`);
      const now = new Date().toISOString();
      if (live.status === 200 && live.body?.student) {
        const ma = { ...live.body.student, id: live.body.student.id ?? live.body.student.studentId };
        const agreeNow = agreementOf(ma, seats);
        await ddb.send(new PutItemCommand({ TableName: ST, Item: { pk: S("student"), sk: S(sid), ma: S(JSON.stringify(ma)), maId: S(ma.id), matchedBy: S("live-lookup"), courseAgreementAtSnapshot: S(agreeNow),
          seats: S(JSON.stringify(seats)), isTestUser: { BOOL: !!gate.body?.user?.metadata?.isTestUser }, snapshotAt: S(now), figuresAsOf: S(now) } }));
        await bumpRead("readMaLookup");
        return resp(200, { ...base, inSnapshot: true, matchedBy: "live-lookup", matchConfidence: "high", figuresAsOf: now, figuresBasis: "Math Academy answered a direct per-student call at figuresAsOf", isTestUser: !!gate.body?.user?.metadata?.isTestUser, mathAcademy: ma, mathAcademyState: maState(ma.currentCourse),
          courseAgreement: agreeNow, courseAgreementAtSnapshot: agreeNow, seatsAtSnapshot: seats, note: "this student was missing from the snapshot, so the store made one live Math Academy call just now, stored the record, and will include the student in the next nightly refresh" });
      }
      await bumpRead("readMaLookup");
      const reason = live.status ? `HTTP ${live.status}` : (live.error || "no answer");
      await ddb.send(new PutItemCommand({ TableName: ST, Item: { pk: S("tb_unmatched"), sk: S(sid), reason: S(reason), seats: S(JSON.stringify(seats)), isTestUser: { BOOL: !!gate.body?.user?.metadata?.isTestUser }, snapshotAt: S(meta.snapshotAt), lastTriedAt: S(now) } }));
      return resp(200, { ...base, inSnapshot: false, matchedBy: null, isTestUser: !!gate.body?.user?.metadata?.isTestUser, seatsAtSnapshot: seats, unmatchedReason: reason, lastTriedAt: now, mathAcademy: null, mathAcademyState: null, courseAgreement: "no math academy record",
        note: "missing from the snapshot; a live Math Academy lookup was made just now and did not find the student (HTTP 404 = no account under this organisation's key; HTTP 401 = account under another organisation's key); it will be retried after 24 hours" });
    }
    if (un.Item) return resp(200, { ...base, inSnapshot: false, matchedBy: null, isTestUser: un.Item.isTestUser?.BOOL ?? null, seatsAtSnapshot: JSON.parse(un.Item.seats?.S || "[]"), unmatchedReason: un.Item.reason?.S, lastTriedAt: un.Item.lastTriedAt?.S || null, mathAcademy: null, mathAcademyState: null, courseAgreementAtSnapshot: "no math academy record", courseAgreement: "no math academy record", note: "on the Timeback roster at snapshot time but no Math Academy record matched (HTTP 404 = no account under this organisation's key; HTTP 401 = account under another organisation's key; 'no email' = nothing to look up by)" });
    return resp(200, { ...base, inSnapshot: false, matchedBy: null, mathAcademy: null, mathAcademyState: null, courseAgreementAtSnapshot: null, courseAgreement: "not in snapshot", note: email ? "not on the Timeback Math Academy roster at the last snapshot; a live Math Academy lookup was tried within the last 24 hours and found nothing (see unmatchedReason on the tb_unmatched row) or the front has no Math Academy key configured" : "not on the Timeback Math Academy roster at the last snapshot and the Timeback user carries no email to look up by" });
  }
  const ma = JSON.parse(row.Item.ma.S);
  const maCourse = ma.currentCourse?.name || null;
  const agreement = agreementOf(ma, seats);
  const matchedBy = row.Item.matchedBy?.S;
  return resp(200, { ...base, inSnapshot: true, matchedBy, matchConfidence: matchedBy === "name" ? "low" : "high",
    figuresAsOf: row.Item.snapshotAt?.S || meta.snapshotAt,
    figuresBasis: ["lookup", "live-lookup"].includes(matchedBy) ? "Math Academy answered a direct per-student call at figuresAsOf" : "Math Academy's bulk list read at figuresAsOf; the list can lag Math Academy's live record by up to a day",
    isTestUser: row.Item.isTestUser?.BOOL ?? null, mathAcademy: minimal ? stripPii(ma) : ma, minimalView: minimal, mathAcademyState: maState(ma.currentCourse), courseAgreement: agreement, courseAgreementAtSnapshot: row.Item.courseAgreementAtSnapshot?.S || null,
    seatsAtSnapshot: JSON.parse(row.Item.seats?.S || "[]"),
    note: "mathAcademy is Math Academy's own record (copied) as of figuresAsOf; timeback.currentMathAcademySeats is read live now with your token; courseAgreement compares Math Academy's course name with EVERY current seat by normalised title and says agree if any seat matches; courseAgreementAtSnapshot is the same rule against seatsAtSnapshot. mathAcademyState 'not started' = progress 0 and xpRemaining 0 with no completion: the course is assigned and no task has been done, so neither figure is a measurement." });
}

const resp = (status, body, headers = {}) => ({
  statusCode: status,
  headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body, null, 1),
});
function serveFile(rel, ct, method) {
  const p = `${PUBLIC}/${rel.replace(/\.\./g, "")}`;
  if (!existsSync(p)) return resp(404, { error: "not found" });
  const buf = readFileSync(p);
  const sha = createHash("sha256").update(buf).digest("hex");
  return { statusCode: 200, headers: { "content-type": ct, "x-doc-sha256": sha, "x-doc-version": process.env.GIT_VERSION || "unversioned", "access-control-allow-origin": "*", "cache-control": "no-store" }, body: method === "HEAD" ? "" : buf.toString("utf-8") };
}
const S = v => ({ S: String(v) }); const N = v => ({ N: String(v) });
const fromItem = it => ({
  number: Number(it.sk.N), title: it.title?.S, state: it.state?.S, kind: it.kind?.S, reporter: it.reporter?.S,
  createdAt: it.createdAt?.S, updatedAt: it.updatedAt?.S, closedAt: it.closedAt?.S || null, labels: LABELS,
  comments: it.comments ? JSON.parse(it.comments.S).length : 0, githubUrl: it.githubUrl?.S || null,
  url: `${process.env.BASE}/feedback/${it.sk.N}`,
});
async function nextNumber() {
  const r = await ddb.send(new UpdateItemCommand({ TableName: T, Key: { pk: S("meta"), sk: N(0) }, UpdateExpression: "ADD #c :one", ExpressionAttributeNames: { "#c": "counter" }, ExpressionAttributeValues: { ":one": N(1) }, ReturnValues: "UPDATED_NEW" }));
  return Number(r.Attributes.counter.N);
}
async function listTickets() {
  const out = []; let key;
  do {
    const r = await ddb.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": S("ticket") }, ExclusiveStartKey: key }));
    out.push(...(r.Items || [])); key = r.LastEvaluatedKey;
  } while (key);
  return out.sort((a, b) => Number(b.sk.N) - Number(a.sk.N));
}
function adminOk(event) {
  const k = event.headers?.["x-admin-key"] || ""; const want = process.env.ADMIN_KEY || "";
  return want && k.length === want.length && timingSafeEqual(Buffer.from(k), Buffer.from(want));
}

async function storeSub(event, q, sid, kind) {
  const token = event.headers?.authorization || event.headers?.Authorization || "";
  if (!/^Bearer\s+\S+/i.test(token)) return resp(401, { error: "send the reader's Timeback token as Authorization: Bearer <token>" });
  const gate = await tbGet(`/ims/oneroster/rostering/v1p2/users/${encodeURIComponent(sid)}`, token);
  if (gate.status !== 200) return resp(gate.status >= 400 && gate.status < 500 ? gate.status : 502, { error: "Timeback did not answer 200 for this student under the presented token; nothing served", timebackStatus: gate.status });
  const meta = await storeMeta(); if (!meta) return resp(503, { error: "no snapshot loaded" });
  const fresh = { snapshotAt: meta.snapshotAt, snapshotAgeHours: meta.snapshotAgeHours, stale: meta.stale, storeBegan: meta.history[0]?.at || meta.snapshotAt };
  if (kind === "history") {
    const rows = (await queryAll(`hist#${sid}`)).map(unmarshalFlat).map(r => ({ date: r.sk, courseId: r.courseId, courseName: r.courseName, progress: r.progress, xpRemaining: r.xpRemaining, completed: r.completed || null, startDate: r.startDate || null, grade: r.grade, letterGrade: r.letterGrade || null, estimatedScore: r.estimatedScore || null, deactivated: r.deactivated, state: r.state, agreement: r.agreement, tbCourseIds: JSON.parse(r.tbCourseIds || "[]") })).sort((a, b) => a.date < b.date ? -1 : 1);
    return resp(200, { sourcedId: sid, ...fresh, nights: rows.length, firstNight: rows[0]?.date || null, lastNight: rows.at(-1)?.date || null, history: rows, note: "one row per DATE (the last snapshot of that date wins) since storeBegan; a course change shows as a different courseId between two dates and the last row of the old course carries its completed date if Math Academy had set it by then; nothing before storeBegan is known here (Timeback's results hold that half: ENABLEMENT ex. 9)" });
  }
  if (kind === "activity") {
    const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
    const from = q.from || "0000-00-00", to = q.to || "9999-12-31";
    if ((q.from && !isDay(q.from)) || (q.to && !isDay(q.to))) return resp(400, { error: "from and to must be YYYY-MM-DD (America/Chicago days); both optional" });
    if (from > to) return resp(400, { error: "from is after to" });
    const tasks = (await queryAll(`act#${sid}`, { cond: " AND sk BETWEEN :a AND :b", vals: { ":a": S(from + "#"), ":b": S(to + "#~") } })).map(unmarshalFlat).map(r => ({ date: r.sk.split("#")[0], taskId: r.taskId, type: r.type, xp: r.xp, xpAwarded: r.xpAwarded, questions: r.questions, questionsCorrect: r.questionsCorrect, startedEpochMs: r.startedEpochMs ?? r.started, completedEpochMs: r.completedEpochMs ?? r.completed, courseId: r.courseId, courseName: r.courseName, topicId: r.topicId, topicName: r.topicName, timeElapsedMs: r.timeElapsedMs ?? r.timeElapsed, timeEngagedMs: r.timeEngagedMs ?? r.timeEngaged, timeProductiveMs: r.timeProductiveMs ?? r.timeProductive }));
    const days = (await queryAll(`actday#${sid}`, { cond: " AND sk BETWEEN :a AND :b", vals: { ":a": S(from), ":b": S(to) } })).map(unmarshalFlat).map(r => ({ date: r.sk, numTasks: r.numTasks, timeElapsedMs: r.timeElapsedMs ?? r.timeElapsed, timeEngagedMs: r.timeEngagedMs ?? r.timeEngaged, timeProductiveMs: r.timeProductiveMs ?? r.timeProductive, xpAwarded: r.xpAwarded, questions: r.questions, questionsCorrect: r.questionsCorrect, windowUtc: r.windowUtc || null, error: r.error || null, fetchedAt: r.fetchedAt }));
    const stuRow = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) } }));
    const reasonIfEmpty = days.length ? null : !stuRow.Item ? "this student has no store row (no Math Academy id known), so no activity day could be pulled; read /store/student/{sourcedId} first" : `no day in ${from}..${to} was pulled for this student: either no Math Academy result in Timeback on those America/Chicago days, or the day is before storeBegan (${fresh.storeBegan.slice(0, 10)}), or after activityLastDate (${meta.activityLastDate || "none yet"})`;
    return resp(200, { sourcedId: sid, ...fresh, reasonIfEmpty, from, to, dayBoundary: "America/Chicago; each day is the UTC window in days[].windowUtc, tasks kept by their Math Academy completion time", units: "every clock and epoch here is MILLISECONDS (task and day alike); divide by 60000 for minutes", activityLastDate: meta.activityLastDate || null, days, tasks, note: "Math Academy's own per-task analysis, pulled the night after each America/Chicago day for students who had a Math Academy result in Timeback that day; a day absent here was not pulled (no Timeback result that day, or before the store began, or the pull has not reached it: see activityLastDate), never a day of zero work; ENABLEMENT example 11" });
  }
  if (kind === "knowledge") {
    const row = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) } }));
    if (!row.Item) return resp(404, { error: "student not in the store; read /store/student/{sourcedId} first (it makes a live lookup on a miss)" });
    const ma = JSON.parse(row.Item.ma.S); const courseId = q.courseId || ma.currentCourse?.id; const maId = row.Item.maId?.S || ma.id;
    if (!courseId) return resp(404, { error: "Math Academy shows no current course for this student" });
    const cached = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S(`know#${sid}`), sk: S(String(courseId)) } }));
    const ageOk = cached.Item && Date.now() - Date.parse(cached.Item.fetchedAt.S) < 7 * 864e5;
    if (cached.Item && ageOk && !q.refresh) return resp(200, { sourcedId: sid, courseId: String(courseId), fetchedAt: cached.Item.fetchedAt.S, fromCache: true, knowledge: JSON.parse(cached.Item.knowledge.S), note: "cached for 7 days per courseId; ?refresh=1 forces one live Math Academy call; the prerequisite courses are already inside courses[]" });
    const live = await maGet(`/students/${encodeURIComponent(maId)}/courses/${encodeURIComponent(courseId)}/knowledge`);
    await bumpRead("readMaKnowledge");
    if (live.status === 404) return resp(404, { error: "Math Academy has no knowledge map for this student and course id (wrong courseId, or a course the student never held)", mathAcademyStatus: 404, studentCurrentCourseId: ma.currentCourse?.id ?? null });
    if (live.status === 429) return resp(429, { error: "Math Academy's fair-use limit answered 429; try later, do not loop this route", mathAcademyStatus: 429, cachedAvailable: !!cached.Item });
    if (live.status !== 200 || !live.body) return resp(live.status === 0 ? 503 : 502, { error: "Math Academy did not return the knowledge map", mathAcademyStatus: live.status, detail: live.error || null, cachedAvailable: !!cached.Item });
    const now = new Date().toISOString(); const know = live.body.courses ? { courses: live.body.courses } : live.body;
    const req = (know.courses || []).find(c => String(c.id) === String(courseId)) || null;
    know.requestedCourse = req ? { id: req.id, name: req.name, completion: req.completion, indexInCourses: know.courses.indexOf(req), topics: (req.units || []).reduce((n, u) => n + (u.modules || []).reduce((m, mo) => m + (mo.topics || []).length, 0), 0) } : null;
    await ddb.send(new PutItemCommand({ TableName: ST, Item: { pk: S(`know#${sid}`), sk: S(String(courseId)), fetchedAt: S(now), knowledge: S(JSON.stringify(know)) } }));
    return resp(200, { sourcedId: sid, courseId: String(courseId), fetchedAt: now, fromCache: false, knowledge: know, note: "one live Math Academy call was made for this map; cached for 7 days PER courseId (the prerequisite courses are already inside courses[], so asking for them by courseId spends another call for nothing); each unit/module/topic carries stability 0-1 (long-term retention); the requested course is usually the LAST element of courses[] (prerequisites first): use requestedCourse or match on id, and note courses[].id is a number while courseId here is a string; a stability of exactly 0 means Math Academy has no current retention evidence: untaught topics AND topics that were just failed both read 0 (open question, ticket 19), so zeros with a Timeback task on record belong at the top of a weakest list, not off it; ENABLEMENT example 12" });
  }
  return resp(404, { error: "unknown store sub-route" });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const p = (event.rawPath || "/").replace(/\/+$/, "") || "/";
  const q = event.queryStringParameters || {};
  if (method === "OPTIONS") return { statusCode: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,x-admin-key,authorization" }, body: "" };

  if (method === "GET" || method === "HEAD") {
    if (p === "/" || p === "/skill") return serveFile("skill.json", "application/json; charset=utf-8", method);
    if (p === "/DICTIONARY.md" || p === "/ENABLEMENT.md") return serveFile(p.slice(1), "text/markdown; charset=utf-8", method);
    if (p === "/about" || p === "/about.html") return serveFile("about.html", "text/html; charset=utf-8", method);
    if (p.startsWith("/reference/") && p.endsWith(".json")) return serveFile(p.slice(1), "application/json; charset=utf-8", method);
  }
  if (p === "/store" && method === "GET") {
    const meta = await storeMeta();
    return meta ? resp(200, { ...meta, routes: ["GET /store/student/{sourcedId}[?minimal=1]", "GET /store/student?email=", "GET /store/student/{sourcedId}/history", "GET /store/student/{sourcedId}/activity?from=&to=", "GET /store/student/{sourcedId}/knowledge[?courseId=&refresh=1]", "GET /store/course/{courseSourcedId}", "GET /store/course/{courseSourcedId}/students[?agreement=]  (token; ids + Math Academy course figures, no names)", "GET /store/course/{courseSourcedId}/activity?date=YYYY-MM-DD  (token; per-student day totals)", "GET /store/courses  (Math Academy course id -> name)"], gate: "student routes and the course student list: Authorization: Bearer <reader's Timeback token>; status and course-count routes: none (counts only)", mathAcademyCallsAtReadTime: "a per-student read makes NO Math Academy call unless the student is missing (then one live lookup, once per 24 h); the knowledge route makes one live call per courseId per 7 days; nothing else reaches Math Academy at read time", notes: STATUS_NOTES }) : resp(404, { error: "no snapshot loaded" });
  }
  const crsList = p.match(/^\/store\/course\/([^/]+)\/students$/);
  if (crsList && method === "GET") {
    const token = event.headers?.authorization || event.headers?.Authorization || "";
    if (!/^Bearer\s+\S+/i.test(token)) return resp(401, { error: "send the reader's Timeback token as Authorization: Bearer <token>" });
    const ok = await tbGet("/ims/oneroster/rostering/v1p2/users/?limit=1", token);
    if (ok.status !== 200) return resp(ok.status === 401 || ok.status === 403 ? ok.status : 502, { error: "Timeback did not accept the token", timebackStatus: ok.status });
    const meta = await storeMeta(); if (!meta) return resp(503, { error: "no snapshot loaded" });
    const cid = decodeURIComponent(crsList[1]); const want = q.agreement || null;
    if (want && !AGREEMENT_VALUES.includes(want)) return resp(400, { error: "unknown agreement value", allowed: AGREEMENT_VALUES });
    const rows = [];
    for (const it of await queryAll("student")) { const seats = JSON.parse(it.seats?.S || "[]"); if (!seats.some(s => s.courseSourcedId === cid)) continue; const ag = it.courseAgreementAtSnapshot?.S; if (want && ag !== want) continue; const ma = JSON.parse(it.ma?.S || "{}"); const cc = ma.currentCourse || {}; rows.push({ sourcedId: it.sk.S, courseAgreementAtSnapshot: ag, matchedBy: it.matchedBy?.S, matchConfidence: it.matchedBy?.S === "name" ? "low" : "high", isTestUser: it.isTestUser?.BOOL ?? null, mathAcademyState: maState(cc), mathAcademyCourseId: cc.id ?? null, mathAcademyCourseName: cc.name ?? null, progress: cc.progress ?? null, xpRemaining: cc.xpRemaining ?? null, completed: cc.completed ?? null, startDate: cc.startDate ?? null, estimatedScore: cc.estimatedScore ?? null, deactivated: ma.deactivated ?? null, figuresAsOf: it.snapshotAt?.S || meta.snapshotAt }); }
    if (!want || want === "no math academy record") for (const it of await queryAll("tb_unmatched")) { const seats = JSON.parse(it.seats?.S || "[]"); if (!seats.some(s => s.courseSourcedId === cid)) continue; rows.push({ sourcedId: it.sk.S, courseAgreementAtSnapshot: "no math academy record", unmatchedReason: it.reason?.S, lastTriedAt: it.lastTriedAt?.S || null, matchedBy: null, isTestUser: it.isTestUser?.BOOL ?? null, mathAcademyState: null, mathAcademyCourseId: null, mathAcademyCourseName: null }); }
    const nonTest = rows.filter(r => r.isTestUser === false).length;
    return resp(200, { courseSourcedId: cid, snapshotAt: meta.snapshotAt, stale: meta.stale, filter: want, count: rows.length, nonTestCount: nonTest, students: rows.length, rows, note: "one row per roster student of this Timeback course at rosterReadAt: opaque user.sourcedId, store labels, and Math Academy's course figures (no names); `students` is the same COUNT as `count` (kept for old readers), the list is `rows`. Values for ?agreement=: " + AGREEMENT_VALUES.join(" | ") + ". A cohort with figures is this one call; resolve a single row with /store/student/{sourcedId}." });
  }
  const crsAct = p.match(/^\/store\/course\/([^/]+)\/activity$/);
  if (crsAct && method === "GET") {
    const token = event.headers?.authorization || event.headers?.Authorization || "";
    if (!/^Bearer\s+\S+/i.test(token)) return resp(401, { error: "send the reader's Timeback token as Authorization: Bearer <token>" });
    const ok = await tbGet("/ims/oneroster/rostering/v1p2/users/?limit=1", token);
    if (ok.status !== 200) return resp(ok.status >= 400 && ok.status < 500 ? ok.status : 502, { error: "Timeback did not accept the token", timebackStatus: ok.status });
    const meta = await storeMeta(); if (!meta) return resp(503, { error: "no snapshot loaded" });
    const day = q.date; if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return resp(400, { error: "give ?date=YYYY-MM-DD (an America/Chicago day the store has pulled; see activityLastDate)" });
    const cid = decodeURIComponent(crsAct[1]);
    const members = [];
    for (const it of await queryAll("student")) { const seats = JSON.parse(it.seats?.S || "[]"); if (seats.some(s => s.courseSourcedId === cid)) members.push({ sid: it.sk.S, isTestUser: it.isTestUser?.BOOL ?? null }); }
    const out = [];
    for (let i = 0; i < members.length; i += 100) {
      const chunk = members.slice(i, i + 100);
      const r = await ddb.send(new BatchGetItemCommand({ RequestItems: { [ST]: { Keys: chunk.map(m => ({ pk: S(`actday#${m.sid}`), sk: S(day) })) } } }));
      for (const it of (r.Responses?.[ST] || [])) { const f = unmarshalFlat(it); const sid = f.pk.slice(7); const m = chunk.find(x => x.sid === sid); out.push({ sourcedId: sid, isTestUser: m?.isTestUser ?? null, numTasks: f.numTasks ?? null, timeElapsedMs: f.timeElapsedMs ?? f.timeElapsed ?? null, timeEngagedMs: f.timeEngagedMs ?? f.timeEngaged ?? null, timeProductiveMs: f.timeProductiveMs ?? f.timeProductive ?? null, xpAwarded: f.xpAwarded ?? null, questions: f.questions ?? null, questionsCorrect: f.questionsCorrect ?? null, error: f.error || null }); }
    }
    const good = out.filter(r => !r.error && r.numTasks); const sum = k => good.reduce((a, r) => a + (r[k] || 0), 0);
    return resp(200, { courseSourcedId: cid, date: day, dayBoundary: "America/Chicago", units: "milliseconds", activityLastDate: meta.activityLastDate || null, snapshotAt: meta.snapshotAt, stale: meta.stale, rosterStudents: members.length, studentsWithActivity: good.length, studentsWithError: out.length - good.length, totals: { numTasks: sum("numTasks"), timeElapsedMs: sum("timeElapsedMs"), timeEngagedMs: sum("timeEngagedMs"), timeProductiveMs: sum("timeProductiveMs"), xpAwarded: sum("xpAwarded") }, rows: out, note: "one row per roster student of this Timeback course who had a pulled activity day on `date` (Math Academy's own per-task analysis summed by the store); students absent from rows had no Math Academy result in Timeback that day or the day was not pulled; opaque ids only; ENABLEMENT example 11" });
  }
  if (p === "/store/courses" && method === "GET") {
    const meta = await storeMeta(); if (!meta) return resp(404, { error: "no snapshot loaded" });
    let r; try { r = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("meta"), sk: S("snapshot") }, ProjectionExpression: "maCourses" })); } catch { r = {}; }
    return resp(200, { snapshotAt: meta.snapshotAt, mathAcademyCourses: JSON.parse(r.Item?.maCourses?.S || "{}"), note: "Math Academy's own course id -> name, as seen on student records in the store (its catalogue vocabulary, not Timeback's course ids); the values in mathAcademyCourseId on the course student list and currentCourse.id on rows" });
  }
  const crs = p.match(/^\/store\/course\/([^/]+)$/);
  if (crs && method === "GET") {
    const meta = await storeMeta(); if (!meta) return resp(404, { error: "no snapshot loaded" });
    const c = meta.byCourse[decodeURIComponent(crs[1])];
    if (c) c.activityLastDate = meta.activityLastDate || null;
    if (!c) return resp(404, { error: "no roster student sat in that Timeback course at snapshot time (or unknown course id)", snapshotAt: meta.snapshotAt, knownCourses: Object.keys(meta.byCourse).length });
    return resp(200, { courseSourcedId: decodeURIComponent(crs[1]), ...c, snapshotAt: meta.snapshotAt, rosterReadAt: meta.rosterReadAt, snapshotAgeHours: meta.snapshotAgeHours, stale: meta.stale,
      note: "counts of roster students (current in-window seats in this course at rosterReadAt) by courseAgreementAtSnapshot; `students`, `byAgreement` and `maNotStarted` INCLUDE test users; `nonTest` carries the same counts for non-test students only, plus byMathAcademyState; maNotStarted = Math Academy progress 0 and not completed (course assigned, nothing done). No student values; the rows are one call away at /store/course/{id}/students with your token." });
  }
  const sub = p.match(/^\/store\/student\/([^/]+)\/(history|activity|knowledge)$/);
  if (sub && method === "GET") return storeSub(event, q, decodeURIComponent(sub[1]), sub[2]);
  const stu = p.match(/^\/store\/student(?:\/([^/]+))?$/);
  if (stu && method === "GET") return storeStudent(event, q, stu[1] ? decodeURIComponent(stu[1]) : null);
  if (p === "/feedback" && method === "GET") {
    const state = "state" in q ? q.state : "open";
    if (!["open", "closed", "all"].includes(state)) return resp(400, { error: "state must be open|closed|all" });
    const items = (await listTickets()).map(fromItem).filter(t => state === "all" || t.state === state);
    return resp(200, items, { "x-state-applied": state, "x-total-count": String(items.length) });
  }
  const one = p.match(/^\/feedback\/(\d+)(\/admin)?$/);
  if (one && method === "GET" && !one[2]) {
    const r = await ddb.send(new GetItemCommand({ TableName: T, Key: { pk: S("ticket"), sk: N(one[1]) } }));
    if (!r.Item) return resp(404, { error: "not found" });
    return resp(200, { ...fromItem(r.Item), body: r.Item.body?.S, comments: JSON.parse(r.Item.comments?.S || "[]") });
  }
  let parsed = null;
  if (method === "POST") {
    try { parsed = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf-8") : (event.body || "{}")); }
    catch { return resp(400, { error: "body must be JSON" }); }
  }
  if (p === "/feedback" && method === "POST") {
    const { title, body, reporter, kind } = parsed || {};
    if (!title || !body || !reporter) return resp(400, { error: "title, body and reporter are required" });
    if (String(title).length > CAPS.title) return resp(413, { error: `title over ${CAPS.title} characters` });
    if (String(body).length > CAPS.body) return resp(413, { error: `body over ${CAPS.body} characters` });
    const n = await nextNumber(); const now = new Date().toISOString();
    await ddb.send(new PutItemCommand({ TableName: T, Item: { pk: S("ticket"), sk: N(n), title: S(String(title)), body: S(String(body)), reporter: S(String(reporter)), kind: S(kind === "ask" ? "ask" : "report"), state: S("open"), createdAt: S(now), updatedAt: S(now), comments: S("[]") } }));
    return resp(201, { number: n, url: `${process.env.BASE}/feedback/${n}`, covers: "this skill's documents, front and reference files", note: `mirrored to GitHub issues on ${process.env.MIRROR_REPO} by the nightly job; githubUrl appears on the ticket once mirrored` });
  }
  if (one && one[2] && method === "POST") {
    if (!adminOk(event)) return resp(401, { error: "admin key required" });
    const { state, githubUrl, comment } = parsed || {};
    const r = await ddb.send(new GetItemCommand({ TableName: T, Key: { pk: S("ticket"), sk: N(one[1]) } }));
    if (!r.Item) return resp(404, { error: "not found" });
    const now = new Date().toISOString(); const names = { "#u": "updatedAt" }; const vals = { ":u": S(now) }; const sets = ["#u = :u"];
    if (state === "open" || state === "closed") { names["#s"] = "state"; vals[":s"] = S(state); sets.push("#s = :s"); if (state === "closed") { names["#c"] = "closedAt"; vals[":c"] = S(now); sets.push("#c = :c"); } }
    if (githubUrl) { names["#g"] = "githubUrl"; vals[":g"] = S(String(githubUrl)); sets.push("#g = :g"); }
    if (comment) { const cs = JSON.parse(r.Item.comments?.S || "[]"); cs.push({ author: "mirror", createdAt: now, body: String(comment) }); names["#m"] = "comments"; vals[":m"] = S(JSON.stringify(cs)); sets.push("#m = :m"); }
    await ddb.send(new UpdateItemCommand({ TableName: T, Key: { pk: S("ticket"), sk: N(one[1]) }, UpdateExpression: "SET " + sets.join(", "), ExpressionAttributeNames: names, ExpressionAttributeValues: vals }));
    return resp(200, { number: Number(one[1]), updated: sets.length - 1 });
  }
  return resp(404, { error: "not found", routes: ["GET /skill", "GET /DICTIONARY.md", "GET /ENABLEMENT.md", "GET /reference/<file>.json", "GET /feedback[?state=]", "GET /feedback/{n}", "POST /feedback", "GET /store", "GET /store/student/{sourcedId}", "GET /store/student?email="] });
};
