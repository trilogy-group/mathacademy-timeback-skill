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
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
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
  return { snapshotAt, rosterReadAt: r.Item.rosterReadAt?.S || snapshotAt, snapshotAgeHours: ageHours, staleAfterDays, stale: ageHours !== null && ageHours > staleAfterDays * 24,
    activityLastDate: r.Item.activityLastDate?.S || null, nightly: r.Item.nightly?.BOOL ?? false, apiVersion: r.Item.apiVersion?.S, history: JSON.parse(r.Item.history?.S || "[]"), calls: JSON.parse(r.Item.calls?.S || "{}"), counts: JSON.parse(r.Item.counts?.S || "{}"), byCourse: JSON.parse(r.Item.byCourse?.S || "{}") };
}
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
const maState = cc => !cc ? null : cc.completed ? "completed" : ((cc.progress || 0) === 0 && (cc.xpRemaining || 0) === 0) ? "not started" : "in progress";
const STATUS_NOTES = {
  refresh: "nightly: snapshot at 03:00 America/Chicago (bulk list + roster + match), activity pull at 03:45 for the previous local day; history lists every snapshotAt ever loaded; a student missing from the snapshot is looked up live once when first asked for.",
  staleness: "stale is true once snapshotAgeHours exceeds staleAfterDays*24 (2 days once nightly runs; a missed night shows here first); past that, quote mathAcademy figures only with their date and prefer Timeback's live containers (ENABLEMENT ex. 3) for progress.",
  calls: "what the snapshot cost: timeback GETs, Math Academy bulk pages, Math Academy per-student lookups.",
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
  if (gate.status !== 200) return resp([401, 403, 404].includes(gate.status) ? gate.status : 502, { error: "Timeback did not answer 200 for this student under the presented token; nothing served", timebackStatus: gate.status });
  const meta = await storeMeta();
  if (!meta) return resp(503, { error: "no snapshot loaded in the store yet" });
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
    if (email && seats.length && Date.now() - lastTried > 864e5 && (await maKey())) {
      const live = await maGet(`/students/${encodeURIComponent(email)}`);
      const now = new Date().toISOString();
      if (live.status === 200 && live.body?.student) {
        const ma = { ...live.body.student, id: live.body.student.id ?? live.body.student.studentId };
        const agreeNow = !ma.currentCourse?.name ? "math academy has no current course" : seats.some(s => normCourse(s.courseName) === normCourse(ma.currentCourse.name)) ? "agree" : (ma.currentCourse?.completed ? "disagree, math academy course completed" : "disagree");
        await ddb.send(new PutItemCommand({ TableName: ST, Item: { pk: S("student"), sk: S(sid), ma: S(JSON.stringify(ma)), maId: S(ma.id), matchedBy: S("live-lookup"), courseAgreementAtSnapshot: S(agreeNow),
          seats: S(JSON.stringify(seats)), isTestUser: { BOOL: !!gate.body?.user?.metadata?.isTestUser }, snapshotAt: S(now), figuresAsOf: S(now) } }));
        return resp(200, { ...base, inSnapshot: true, matchedBy: "live-lookup", matchConfidence: "high", figuresAsOf: now, isTestUser: !!gate.body?.user?.metadata?.isTestUser, mathAcademy: ma, mathAcademyState: maState(ma.currentCourse),
          courseAgreement: agreeNow, courseAgreementAtSnapshot: agreeNow, seatsAtSnapshot: seats, note: "this student was missing from the snapshot, so the store made one live Math Academy call just now, stored the record, and will include the student in the next nightly refresh" });
      }
      const reason = live.status ? `HTTP ${live.status}` : (live.error || "no answer");
      await ddb.send(new PutItemCommand({ TableName: ST, Item: { pk: S("tb_unmatched"), sk: S(sid), reason: S(reason), seats: S(JSON.stringify(seats)), isTestUser: { BOOL: !!gate.body?.user?.metadata?.isTestUser }, snapshotAt: S(meta.snapshotAt), lastTriedAt: S(now) } }));
      return resp(200, { ...base, inSnapshot: false, matchedBy: null, isTestUser: !!gate.body?.user?.metadata?.isTestUser, seatsAtSnapshot: seats, unmatchedReason: reason, lastTriedAt: now, mathAcademy: null, mathAcademyState: null, courseAgreement: "no math academy record",
        note: "missing from the snapshot; a live Math Academy lookup was made just now and did not find the student (HTTP 404 = no account under this organisation's key; HTTP 401 = account under another organisation's key); it will be retried after 24 hours" });
    }
    if (un.Item) return resp(200, { ...base, inSnapshot: false, matchedBy: null, isTestUser: un.Item.isTestUser?.BOOL ?? null, seatsAtSnapshot: JSON.parse(un.Item.seats?.S || "[]"), unmatchedReason: un.Item.reason?.S, mathAcademy: null, mathAcademyState: null, courseAgreement: "no math academy record", note: "on the Timeback roster at snapshot time but no Math Academy record matched (HTTP 404 = no account under this organisation's key; HTTP 401 = account under another organisation's key; 'no email' = nothing to look up by)" });
    return resp(200, { ...base, inSnapshot: false, matchedBy: null, mathAcademy: null, courseAgreement: "not in snapshot", note: "not on the Timeback Math Academy roster at snapshot time and not looked up since; the snapshot is one-off (no refresh scheduled) and this route makes no Math Academy call" });
  }
  const ma = JSON.parse(row.Item.ma.S);
  const maCourse = ma.currentCourse?.name || null;
  const agreement = !maCourse ? "math academy has no current course" : seats.length === 0 ? "no current timeback seat" : seats.some(s => normCourse(s.courseName) === normCourse(maCourse)) ? "agree" : (ma.currentCourse?.completed ? "disagree, math academy course completed" : "disagree");
  const matchedBy = row.Item.matchedBy?.S;
  return resp(200, { ...base, inSnapshot: true, matchedBy, matchConfidence: matchedBy === "name" ? "low" : "high",
    figuresAsOf: matchedBy === "lookup" ? meta.snapshotAt : `bulk list: up to one day before ${meta.snapshotAt}`,
    isTestUser: row.Item.isTestUser?.BOOL ?? null, mathAcademy: ma, mathAcademyState: maState(ma.currentCourse), courseAgreement: agreement, courseAgreementAtSnapshot: row.Item.courseAgreementAtSnapshot?.S || null,
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
  if (gate.status !== 200) return resp([401, 403, 404].includes(gate.status) ? gate.status : 502, { error: "Timeback did not answer 200 for this student under the presented token; nothing served", timebackStatus: gate.status });
  const meta = await storeMeta(); if (!meta) return resp(503, { error: "no snapshot loaded" });
  if (kind === "history") {
    const rows = (await queryAll(`hist#${sid}`)).map(unmarshalFlat).map(r => ({ date: r.sk, courseId: r.courseId, courseName: r.courseName, progress: r.progress, xpRemaining: r.xpRemaining, completed: r.completed || null, startDate: r.startDate || null, grade: r.grade, letterGrade: r.letterGrade || null, estimatedScore: r.estimatedScore || null, deactivated: r.deactivated, state: r.state, agreement: r.agreement, tbCourseIds: JSON.parse(r.tbCourseIds || "[]") })).sort((a, b) => a.date < b.date ? -1 : 1);
    return resp(200, { sourcedId: sid, nights: rows.length, firstNight: rows[0]?.date || null, lastNight: rows.at(-1)?.date || null, history: rows, note: "one row per nightly snapshot since the store began (a snapshot is Math Academy's record that night); a course change shows as a different courseId between two nights and the last row of the old course carries its completed date; nothing before firstNight is known here" });
  }
  if (kind === "activity") {
    const from = q.from || "0000-00-00", to = q.to || "9999-12-31";
    const tasks = (await queryAll(`act#${sid}`, { cond: " AND sk BETWEEN :a AND :b", vals: { ":a": S(from + "#"), ":b": S(to + "#~") } })).map(unmarshalFlat).map(r => ({ date: r.sk.split("#")[0], taskId: r.taskId, type: r.type, xp: r.xp, xpAwarded: r.xpAwarded, questions: r.questions, questionsCorrect: r.questionsCorrect, startedEpochSec: r.started, completedEpochSec: r.completed, courseId: r.courseId, courseName: r.courseName, topicId: r.topicId, topicName: r.topicName, timeElapsedMs: r.timeElapsed, timeEngagedMs: r.timeEngaged, timeProductiveMs: r.timeProductive }));
    const days = (await queryAll(`actday#${sid}`, { cond: " AND sk BETWEEN :a AND :b", vals: { ":a": S(from), ":b": S(to) } })).map(unmarshalFlat).map(r => ({ date: r.sk, numTasks: r.numTasks, timeElapsedSec: r.timeElapsed, timeEngagedSec: r.timeEngaged, timeProductiveSec: r.timeProductive, xpAwarded: r.xpAwarded, questions: r.questions, questionsCorrect: r.questionsCorrect, error: r.error || null, fetchedAt: r.fetchedAt }));
    return resp(200, { sourcedId: sid, from, to, activityLastDate: meta.activityLastDate || null, days, tasks, note: "Math Academy's own per-task analysis, pulled the night after each local day for students who were active that day (America/Chicago days); timeElapsed/Engaged/Productive are Math Academy's three clocks in milliseconds per task and seconds in the day totals; a day absent here was not pulled (no Math Academy result that day, or before the store began), not a day of zero work; ENABLEMENT example 11" });
  }
  if (kind === "knowledge") {
    const row = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) } }));
    if (!row.Item) return resp(404, { error: "student not in the store; read /store/student/{sourcedId} first (it makes a live lookup on a miss)" });
    const ma = JSON.parse(row.Item.ma.S); const courseId = q.courseId || ma.currentCourse?.id; const maId = row.Item.maId?.S || ma.id;
    if (!courseId) return resp(404, { error: "Math Academy shows no current course for this student" });
    const cached = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S(`know#${sid}`), sk: S(String(courseId)) } }));
    const ageOk = cached.Item && Date.now() - Date.parse(cached.Item.fetchedAt.S) < 7 * 864e5;
    if (cached.Item && ageOk && !q.refresh) return resp(200, { sourcedId: sid, courseId: String(courseId), fetchedAt: cached.Item.fetchedAt.S, fromCache: true, knowledge: JSON.parse(cached.Item.knowledge.S), note: "cached for 7 days; ?refresh=1 forces one live Math Academy call" });
    const live = await maGet(`/students/${encodeURIComponent(maId)}/courses/${encodeURIComponent(courseId)}/knowledge`);
    if (live.status !== 200 || !live.body) return resp(live.status === 0 ? 503 : 502, { error: "Math Academy did not return the knowledge map", mathAcademyStatus: live.status, detail: live.error || null, cachedAvailable: !!cached.Item });
    const now = new Date().toISOString(); const know = live.body.courses ? { courses: live.body.courses } : live.body;
    await ddb.send(new PutItemCommand({ TableName: ST, Item: { pk: S(`know#${sid}`), sk: S(String(courseId)), fetchedAt: S(now), knowledge: S(JSON.stringify(know)) } }));
    return resp(200, { sourcedId: sid, courseId: String(courseId), fetchedAt: now, fromCache: false, knowledge: know, note: "one live Math Academy call was made for this map; cached for 7 days; courses[] holds the requested course plus up to two prerequisite courses, each unit/module/topic with stability 0-1 (long-term retention); ENABLEMENT example 12" });
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
    if (p.startsWith("/reference/") && p.endsWith(".json")) return serveFile(p.slice(1), "application/json; charset=utf-8", method);
  }
  if (p === "/store" && method === "GET") {
    const meta = await storeMeta();
    return meta ? resp(200, { ...meta, routes: ["GET /store/student/{sourcedId}", "GET /store/student?email=", "GET /store/student/{sourcedId}/history", "GET /store/student/{sourcedId}/activity?from=&to=", "GET /store/student/{sourcedId}/knowledge[?courseId=&refresh=1]", "GET /store/course/{courseSourcedId}"], gate: "student routes: Authorization: Bearer <reader's Timeback token>; status and course routes: none (counts only)", notes: STATUS_NOTES }) : resp(404, { error: "no snapshot loaded" });
  }
  const crs = p.match(/^\/store\/course\/([^/]+)$/);
  if (crs && method === "GET") {
    const meta = await storeMeta(); if (!meta) return resp(404, { error: "no snapshot loaded" });
    const c = meta.byCourse[decodeURIComponent(crs[1])];
    if (c) c.activityLastDate = meta.activityLastDate || null;
    if (!c) return resp(404, { error: "no roster student sat in that Timeback course at snapshot time (or unknown course id)", snapshotAt: meta.snapshotAt, knownCourses: Object.keys(meta.byCourse).length });
    return resp(200, { courseSourcedId: decodeURIComponent(crs[1]), ...c, snapshotAt: meta.snapshotAt, rosterReadAt: meta.rosterReadAt, snapshotAgeHours: meta.snapshotAgeHours, stale: meta.stale,
      note: "counts of roster students (current in-window seats in this course at rosterReadAt) by courseAgreementAtSnapshot; testUsers counted inside students; maNotStarted = Math Academy shows progress 0 and xpRemaining 0 (course assigned, no task done yet). No student values; for rows use /store/student/{sourcedId} with your token, about one second each." });
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
