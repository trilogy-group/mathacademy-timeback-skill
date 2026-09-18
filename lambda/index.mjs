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
  const scheduled = history.filter(h => h.source === "schedule").length; const manualRuns = history.filter(h => h.source === "manual").length;
  // next 03:00 America/Chicago as UTC (CDT = UTC-5; CST = UTC-6). Approximate DST by month.
  const now = new Date();
  const chicagoOffsetHours = d => { const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" }).formatToParts(d).find(x => x.type === "timeZoneName").value; const m = /GMT([+-]\d+)/.exec(p); return m ? -Number(m[1]) : 6; };
  let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3 + chicagoOffsetHours(now), 0, 0)); if (next <= now) next = new Date(next.getTime() + 864e5);
  return { snapshotAt, rosterReadAt: r.Item.rosterReadAt?.S || snapshotAt, snapshotAgeHours: ageHours, staleAfterDays, stale: ageHours !== null && ageHours > staleAfterDays * 24,
    schedule: { snapshot: "03:00 America/Chicago daily", activity: "03:45 America/Chicago daily, for every America/Chicago day from the day before the last pulled day through yesterday (the overlap day is re-pulled for late rows); daysPulled[] on lastActivityRun lists them", nextSnapshotDueUtc: next.toISOString(), scheduledRunsSoFar: scheduled, manualRunsSoFar: manualRuns, schedulerTestRuns: history.length - scheduled - manualRuns, firstScheduledRunHasHappened: scheduled > 0 },
    activityLastDate: r.Item.activityLastDate?.S || null, lastActivityRun: r.Item.lastActivityRun?.S ? JSON.parse(r.Item.lastActivityRun.S) : null,
    nightly: r.Item.nightly?.BOOL ?? false, apiVersion: r.Item.apiVersion?.S, history,
    snapshotCalls: JSON.parse(r.Item.calls?.S || "{}"), readCalls: { maLookupOnMiss: num(r.Item.readMaLookup) || 0, maKnowledge: num(r.Item.readMaKnowledge) || 0, maActivityBackfill: num(r.Item.readMaActivityBackfill) || 0, maActivityBackfillStudents: num(r.Item.readMaActivityBackfillStudents) || 0, counterNote: "maActivityBackfill = Math Academy CALLS spent by on-demand activity backfills since 2026-09-17T23:50Z (about five per student); maActivityBackfillStudents = students backfilled on demand since then; the 24 students backfilled on demand before that instant are in neither figure" }, backfill: r.Item.backfill?.S ? JSON.parse(r.Item.backfill.S) : null,
    counts: JSON.parse(r.Item.counts?.S || "{}"), byCourse: JSON.parse(r.Item.byCourse?.S || "{}") };
}
async function tokenOk(event) {
  const token = event.headers?.authorization || event.headers?.Authorization || "";
  if (!/^Bearer\s+\S+/i.test(token)) return { ok: false, status: 401 };
  const r = await tbGet("/ims/oneroster/rostering/v1p2/users/?limit=1", token);
  return { ok: r.status === 200, status: r.status, token };
}
async function bumpRead(field, by = 1) { try { await ddb.send(new UpdateItemCommand({ TableName: ST, Key: { pk: S("meta"), sk: S("snapshot") }, UpdateExpression: "ADD #f :one", ExpressionAttributeNames: { "#f": field }, ExpressionAttributeValues: { ":one": N(by) } })); } catch (e) { console.log("bumpRead failed", field, e?.name, e?.message); } }
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
const numish = v => (v === null || v === undefined || v === "" || v === "None" || v === "undefined" || v === "null") ? null : (/^\d+$/.test(String(v)) ? Number(v) : v);   // Math Academy ids are numbers; serve them as numbers everywhere
const unmarshalFlat = it => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, v.S !== undefined ? v.S : v.N !== undefined ? Number(v.N) : v.BOOL !== undefined ? v.BOOL : null]));
const maState = cc => !cc ? null : cc.completed ? "completed" : (cc.progress === null || cc.progress === undefined) ? "in progress" : cc.progress >= 0.995 ? "at 100, not marked complete" : cc.progress === 0 ? "not started" : "in progress";
const AGREEMENT_VALUES = ["agree", "agree, math academy course completed", "disagree", "disagree, math academy course completed", "no current timeback seat", "math academy has no current course", "no math academy record", "not in snapshot"];
const agreementOf = (ma, seats) => { const name = ma?.currentCourse?.name; if (!name) return "math academy has no current course"; if (!seats.length) return "no current timeback seat"; const done = !!ma.currentCourse?.completed; return seats.some(s => normCourse(s.courseName) === normCourse(name)) ? (done ? "agree, math academy course completed" : "agree") : (done ? "disagree, math academy course completed" : "disagree"); };
const stripPii = ma => { if (!ma) return ma; const { username, firstName, lastName, league, schedule, ...rest } = ma; return rest; };
const STATUS_NOTES = {
  refresh: "nightly: snapshot at 03:00 America/Chicago (bulk list + roster + match), activity pull at 03:45 for every local day from the day before the last pulled day through yesterday (the overlap day re-pulled for late rows; lastActivityRun.daysPulled lists them); history lists every snapshotAt ever loaded; a student missing from the snapshot is looked up live once when first asked for.",
  staleness: "stale is true once snapshotAgeHours exceeds staleAfterDays*24 (2 days; a missed night shows here first); past that, quote mathAcademy figures only with their date and take today's progress from Timeback's newest result (ENABLEMENT B4) until the store catches up.",
  snapshotCalls: "what the last snapshot run cost: timeback GETs, Math Academy bulk pages, Math Academy per-student lookups (it does not include the activity pull or read-time calls).",
  lastActivityRun: "the last finished activity pull: its day, students, done, errors, students without a Math Academy id, Math Academy calls, the UTC window used, finishedAt.",
  readCalls: "estate-wide (all readers) count of Math Academy calls this front has made on readers' behalf since the store began: maLookupOnMiss (a per-student read of a student missing from the store, once per 24 h), maKnowledge (one per student per courseId per 7 days), maActivityBackfill (Math Academy calls spent by the FIRST /activity read of a student the batch has not reached: about five per student, once; maActivityBackfillStudents counts those students). After that first read, /activity, /history and the course routes never reach Math Academy and may be looped.",
  range: "the store holds every student with a current in-window Math Academy seat at rosterReadAt, every student who ever held a seat since 2025-07-01 (matched by the backfill batch), and anyone a reader or the activity pull looked up; a student who has no current seat keeps their row with seatsAtSnapshot [], courseAgreementAtSnapshot 'no current timeback seat' and offRosterSince; only a student never seated since 2025-07-01 and never asked for reads 'not in snapshot'.",
  schedule: "the two EventBridge schedules and the next snapshot due; firstScheduledRunHasHappened is false until the first 03:00 run lands (history[].source says schedule or manual).",
  counts: "counts.courseAgreement uses the same vocabulary as the rows (agree | agree, math academy course completed | disagree | disagree, math academy course completed | no math academy record); byCourse breaks the roster down by Timeback course sourcedId with test users counted separately (nonTest uses isLikelyTest); byMathAcademyState describes each student's CURRENT Math Academy course, which under a disagree row is a different course from the Timeback heading (a 'completed' there can be a Prealgebra finisher seated in Algebra I); students who finished THIS course and were moved on by progression are not on its roster at all (`/store/finishers` lists them by Math Academy's own flag, ENABLEMENT A5); no student values anywhere here.",
};
async function storeStudent(event, q, sidFromPath) {
  const token = event.headers?.authorization || event.headers?.Authorization || "";
  if (!/^Bearer\s+\S+/i.test(token)) return resp(401, { error: "send the reader's Timeback token as Authorization: Bearer <token>; this route serves a student only after Timeback answers 200 for that student under that token" });
  let sid = sidFromPath || null;
  if (!sid && q.email) {
    const u = await tbGet(`/ims/oneroster/rostering/v1p2/users/?filter=${encodeURIComponent(`email='${q.email}'`)}&limit=2`, token);
    if (u.status !== 200) return resp(u.status >= 400 && u.status < 500 ? u.status : 502, { error: u.status === 401 || u.status === 403 ? "Timeback did not accept the token for the users lookup" : u.status >= 400 && u.status < 500 ? "Timeback rejected the email filter (passed through with Timeback's status; a 422 is a malformed or unquotable email value)" : "Timeback did not answer the users lookup", timebackStatus: u.status });
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
      return resp(200, { ...base, inSnapshot: false, matchedBy: null, isTestUser: !!gate.body?.user?.metadata?.isTestUser, seatsAtSnapshot: seats, unmatchedReason: reason, lastTriedAt: now, mathAcademy: null, mathAcademyState: "no math academy record", courseAgreementAtSnapshot: "no math academy record", courseAgreement: "no math academy record",
        note: "missing from the snapshot; a live Math Academy lookup was made just now and did not find the student (HTTP 404 = no account under this organisation's key; HTTP 401 = account under another organisation's key); it will be retried after 24 hours" });
    }
    if (un.Item) return resp(200, { ...base, inSnapshot: false, matchedBy: null, matchConfidence: null, figuresAsOf: null, figuresBasis: null, minimalView: minimal, isTestUser: un.Item.isTestUser?.BOOL ?? null, isLikelyTest: un.Item.isLikelyTest?.BOOL ?? (un.Item.isTestUser?.BOOL ?? null), seatsAtSnapshot: JSON.parse(un.Item.seats?.S || "[]"), unmatchedReason: un.Item.reason?.S, lastTriedAt: un.Item.lastTriedAt?.S || null, mathAcademy: null, mathAcademyState: "no math academy record", courseAgreementAtSnapshot: "no math academy record", courseAgreement: "no math academy record", note: "on the Timeback roster at snapshot time but no Math Academy record matched (HTTP 404 = no account under this organisation's key; HTTP 401 = account under another organisation's key; 'no email' = nothing to look up by)" });
    return resp(200, { ...base, inSnapshot: false, matchedBy: null, mathAcademy: null, mathAcademyState: null, courseAgreementAtSnapshot: null, courseAgreement: "not in snapshot", note: email ? "not on the Timeback Math Academy roster at the last snapshot; a live Math Academy lookup was tried within the last 24 hours and found nothing (see unmatchedReason on the tb_unmatched row) or the front has no Math Academy key configured" : "not on the Timeback Math Academy roster at the last snapshot and the Timeback user carries no email to look up by" });
  }
  let ma = JSON.parse(row.Item.ma.S); let refreshed = null;
  const offRosterSince = row.Item.offRosterSince?.S || null;
  if (offRosterSince && Date.now() - Date.parse(row.Item.lastTriedAt?.S || row.Item.figuresAsOf?.S || row.Item.snapshotAt?.S || 0) > 864e5 && (await maKey())) {
    // a student who left the roster is no longer refreshed by the nightly bulk list: refresh on read, once per 24 h, like a miss
    const live = await maGet(`/students/${encodeURIComponent(row.Item.maId?.S || ma.id)}`); await bumpRead("readMaLookup"); const now = new Date().toISOString();
    if (live.status === 200 && live.body?.student) { ma = { ...live.body.student, id: live.body.student.id ?? live.body.student.studentId }; refreshed = now;
      await ddb.send(new UpdateItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) }, UpdateExpression: "SET ma = :m, figuresAsOf = :t, lastTriedAt = :t, matchedBy = :b", ExpressionAttributeValues: { ":m": S(JSON.stringify(ma)), ":t": S(now), ":b": S("live-lookup") } })); }
    else await ddb.send(new UpdateItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) }, UpdateExpression: "SET lastTriedAt = :t", ExpressionAttributeValues: { ":t": S(now) } }));
  }
  const maCourse = ma.currentCourse?.name || null;
  const agreement = agreementOf(ma, seats);
  const matchedBy = refreshed ? "live-lookup" : row.Item.matchedBy?.S;
  return resp(200, { ...base, inSnapshot: true, matchedBy, matchConfidence: matchedBy === "name" ? "low" : "high", offRosterSince, offRosterNote: offRosterSince ? "this student holds no current Math Academy seat in Timeback; offRosterSince is the first load that found this row without a seat (for a row created by a lookup of a seatless student it says nothing about when the seat closed: read the seat's dateLastModified in the enrollments); the store keeps their last-known Math Academy record and refreshes it by a direct Math Academy call on read, once per 24 h (counted in readCalls.maLookupOnMiss); their history and backfilled activity stay readable" : undefined,
    figuresAsOf: refreshed || (/^\d{4}-\d{2}-\d{2}T/.test(row.Item.figuresAsOf?.S || "") ? row.Item.figuresAsOf.S : null) || row.Item.snapshotAt?.S || meta.snapshotAt,
    figuresBasis: ["lookup", "live-lookup", "backfill-lookup", "activity-lookup"].includes(matchedBy) ? "Math Academy answered a direct per-student call at figuresAsOf" : "Math Academy's bulk list read at figuresAsOf; the list can lag Math Academy's live record by up to a day",
    isTestUser: row.Item.isTestUser?.BOOL ?? null, isLikelyTest: row.Item.isLikelyTest?.BOOL ?? (row.Item.isTestUser?.BOOL ?? null), mathAcademy: minimal ? stripPii(ma) : ma, minimalView: minimal, mathAcademyState: maState(ma.currentCourse), xpRemainingReading: xpReading(ma.currentCourse), courseAgreement: agreement, courseAgreementAtSnapshot: row.Item.courseAgreementAtSnapshot?.S || null,
    seatsAtSnapshot: JSON.parse(row.Item.seats?.S || "[]"),
    note: "mathAcademy is Math Academy's own record (copied) as of figuresAsOf; timeback.currentMathAcademySeats is read live now with your token; courseAgreement compares Math Academy's course name with EVERY current seat by normalised title and says agree if any seat matches; courseAgreementAtSnapshot is the same rule against seatsAtSnapshot. mathAcademyState 'not started' = progress 0 and no completion: nothing done yet in the CURRENT Math Academy course (a placement, or results under a previous course, may still exist in Timeback); xpRemaining is then 0 or a per-student figure Math Academy pre-sized, not the course size. isLikelyTest = isTestUser OR a synthetic naming pattern OR a test campus, judged in the store so readers never look at names." });
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

const chicagoDay = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });   // YYYY-MM-DD
const chicagoWindowUtc = day => { const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" }); const off = d => { const m = /GMT([+-]\d+)/.exec(f.formatToParts(d).find(x => x.type === "timeZoneName").value); return m ? Number(m[1]) : -5; };
  const guess = new Date(day + "T06:00:00Z"); const o = off(guess); const start = new Date(Date.parse(day + "T00:00:00Z") - o * 36e5); const o2 = off(new Date(start.getTime() + 864e5)); const end = new Date(Date.parse(day + "T00:00:00Z") + 864e5 - o2 * 36e5); return `${start.toISOString()}/${end.toISOString()}`; };
async function backfillStudentActivity(sid, maId, from = "2025-07-01") {
  // per-quarter Math Academy activity for one student, bucketed into America/Chicago days; rows keyed by task so re-runs overwrite
  const end = new Date(); const ranges = []; let a = new Date(from + "T00:00:00Z");
  while (a <= end) { const b = new Date(Math.min(a.getTime() + 91 * 864e5, end.getTime())); ranges.push([a.toISOString().slice(0, 10), b.toISOString().slice(0, 10)]); a = new Date(b.getTime() + 864e5); }
  const byDay = {}; let calls = 0;
  for (const [s, e] of ranges) {
    const r = await maGet(`/students/${encodeURIComponent(maId)}/activity?startDate=${s}&endDate=${e}`); calls++;
    if (r.status !== 200) continue;
    for (const task of (r.body?.activity?.tasks || [])) { if (!task.completed) continue; const day = chicagoDay(Number(task.completed)); (byDay[day] ||= []).push(task); }
  }
  const N1 = v => ({ N: String(v || 0) }); const puts = [];
  for (const [day, tasks] of Object.entries(byDay)) {
    for (const task of tasks) { const an = task.analysis || {}; puts.push({ PutRequest: { Item: { pk: S(`act#${sid}`), sk: S(`${day}#${task.id}`), taskId: S(task.id), type: S(task.type), xp: N1(task.xp), xpAwarded: N1(task.xpAwarded), questions: N1(task.questions), questionsCorrect: N1(task.questionsCorrect), startedEpochMs: N1(task.started), completedEpochMs: N1(task.completed), courseId: S(task.course?.id), courseName: S(task.course?.name), topicId: S(task.topic?.id ?? ""), topicName: S(task.topic?.name ?? ""), timeElapsedMs: N1(an.timeElapsed), timeEngagedMs: N1(an.timeEngaged), timeProductiveMs: N1(an.timeProductive) } } }); }
    const sum = k => tasks.reduce((x, task) => x + Number((task.analysis || {})[k] || 0), 0);
    puts.push({ PutRequest: { Item: { pk: S(`actday#${sid}`), sk: S(day), numTasks: N1(tasks.length), timeElapsedMs: N1(sum("timeElapsed")), timeEngagedMs: N1(sum("timeEngaged")), timeProductiveMs: N1(sum("timeProductive")), xpAwarded: N1(tasks.reduce((x, task) => x + Number(task.xpAwarded || 0), 0)), questions: N1(tasks.reduce((x, task) => x + Number(task.questions || 0), 0)), questionsCorrect: N1(tasks.reduce((x, task) => x + Number(task.questionsCorrect || 0), 0)), byType: S(JSON.stringify(tasks.reduce((a, task) => (a[String(task.type || "?")] = (a[String(task.type || "?")] || 0) + 1, a), {}))), lessons: N1(tasks.filter(task => /^lesson$/i.test(String(task.type))).length), lessonsNegative: N1(tasks.filter(task => /^lesson$/i.test(String(task.type)) && Number(task.xpAwarded || 0) < 0).length), lessonsZero: N1(tasks.filter(task => /^lesson$/i.test(String(task.type)) && Number(task.xpAwarded || 0) === 0).length), windowUtc: S(chicagoWindowUtc(day)), source: S("on-demand-backfill"), fetchedAt: S(new Date().toISOString()) } } });
  }
  const { BatchWriteItemCommand } = await import("@aws-sdk/client-dynamodb");
  for (let i = 0; i < puts.length; i += 25) { let chunk = puts.slice(i, i + 25); for (let tries = 0; tries < 6 && chunk.length; tries++) { const r = await ddb.send(new BatchWriteItemCommand({ RequestItems: { [ST]: chunk } })); chunk = r.UnprocessedItems?.[ST] || []; } }
  await ddb.send(new UpdateItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) }, UpdateExpression: "SET backfilledAt = :t, backfilledFrom = :f", ExpressionAttributeValues: { ":t": S(new Date().toISOString()), ":f": S(from) } }));
  await bumpRead("readMaActivityBackfill", calls); await bumpRead("readMaActivityBackfillStudents");
  return { calls, tasks: puts.length - Object.keys(byDay).length, days: Object.keys(byDay).length };
}
function xpReading(cc) {
  if (!cc || cc.progress === null || cc.progress === undefined) return cc && cc.estimatedScore !== undefined && cc.estimatedScore !== null ? "unknown: SAT Math Prep reports a score, not XP" : null;
  const p = Number(cc.progress), x = Number(cc.xpRemaining ?? 0);
  if (p === 0 && x === 0) return "not computed yet (not started)";
  if (p === 0) return "Math Academy's pre-sized figure for an untouched course";
  if (x === 0 && p < 0.995) return "unknown, nearly done (0 below 99.5 percent)";
  if (cc.completed) return "course completed";
  return "Math Academy's own figure";
}
function withRequested(know, courseId) {
  const req = (know.courses || []).find(c => String(c.id) === String(courseId)) || null;
  know.requestedCourse = req ? { id: req.id, name: req.name, completion: req.completion ?? null, indexInCourses: know.courses.indexOf(req), topicCount: (req.units || []).reduce((n, u) => n + (u.modules || []).reduce((m, mo) => m + (mo.topics || []).length, 0), 0), note: "a pointer: walk knowledge.courses[indexInCourses].units[] for the tree" } : null;
  return know;
}
async function storeSub(event, q, sid, kind) {
  const token = event.headers?.authorization || event.headers?.Authorization || "";
  if (!/^Bearer\s+\S+/i.test(token)) return resp(401, { error: "send the reader's Timeback token as Authorization: Bearer <token>" });
  const gate = await tbGet(`/ims/oneroster/rostering/v1p2/users/${encodeURIComponent(sid)}`, token);
  if (gate.status !== 200) return resp(gate.status >= 400 && gate.status < 500 ? gate.status : 502, { error: "Timeback did not answer 200 for this student under the presented token; nothing served", timebackStatus: gate.status });
  const meta = await storeMeta(); if (!meta) return resp(503, { error: "no snapshot loaded" });
  const fresh = { snapshotAt: meta.snapshotAt, snapshotAgeHours: meta.snapshotAgeHours, stale: meta.stale, storeBegan: meta.history[0]?.at || meta.snapshotAt };
  if (kind === "courses") {
    const stuRow = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) } }));
    const tasks = (await queryAll(`act#${sid}`)).map(unmarshalFlat);
    const byCourse = {};
    for (const r of tasks) {
      const k = String(r.courseId ?? "unknown"); const c = (byCourse[k] ||= { mathAcademyCourseId: numish(r.courseId), mathAcademyCourseName: r.courseName || null, tasks: 0, lessons: 0, xpAwarded: 0, byType: {}, firstTaskEpochMs: null, lastTaskEpochMs: null, lastLessonEpochMs: null });
      const done = Number(r.completedEpochMs || 0); const ty = String(r.type || "?");
      c.tasks++; c.xpAwarded += Number(r.xpAwarded || 0); c.byType[ty] = (c.byType[ty] || 0) + 1;
      if (c.firstTaskEpochMs === null || done < c.firstTaskEpochMs) c.firstTaskEpochMs = done;
      if (c.lastTaskEpochMs === null || done > c.lastTaskEpochMs) c.lastTaskEpochMs = done;
      if (/^lesson$/i.test(ty)) { c.lessons++; if (c.lastLessonEpochMs === null || done > c.lastLessonEpochMs) c.lastLessonEpochMs = done; }
    }
    const iso = ms => ms ? new Date(ms).toISOString() : null;
    const episodes = Object.values(byCourse).sort((a, b) => a.firstTaskEpochMs - b.firstTaskEpochMs).map(c => ({ ...c, firstTaskAt: iso(c.firstTaskEpochMs), lastTaskAt: iso(c.lastTaskEpochMs), lastLessonAt: iso(c.lastLessonEpochMs), firstDayChicago: c.firstTaskEpochMs ? chicagoDay(c.firstTaskEpochMs) : null, lastDayChicago: c.lastTaskEpochMs ? chicagoDay(c.lastTaskEpochMs) : null }));
    const ma = stuRow.Item?.ma?.S ? JSON.parse(stuRow.Item.ma.S) : null; const cc = ma?.currentCourse || null;
    return resp(200, { sourcedId: sid, ...fresh, activityLastDate: meta.activityLastDate || null, coverage: stuRow.Item?.backfilledAt ? { backfilledAt: stuRow.Item.backfilledAt.S, backfilledFrom: stuRow.Item.backfilledFrom?.S || "2025-07-01" } : { backfilledAt: null, note: "not backfilled yet: read /activity once (about five Math Academy calls) and this route fills" },
      currentCourse: cc ? { mathAcademyCourseId: cc.id ?? null, mathAcademyCourseName: cc.name ?? null, startDate: cc.startDate ?? null, progress: cc.progress ?? null, xpRemaining: cc.xpRemaining ?? null, completed: cc.completed ?? null, figuresAsOf: stuRow.Item?.figuresAsOf?.S || null } : null,
      episodes, tasksTotal: tasks.length,
      note: "Math Academy's OWN attribution of every stored task to its course (the course Math Academy was running the student in when the task was done), grouped into episodes ordered by first task; this is the student's Math Academy course history independent of Timeback seats and of the Timeback course each event was filed under (that half is Timeback's, ENABLEMENT part B). An episode's lastLessonAt is the date Math Academy usually sets completed at; a course change shows as one episode ending and the next beginning; a short episode with a new course after it can be a switch, not a finish (read progress/completed on the current course and /history). Rows exist from backfilledFrom (2025-07-01) onward; the current day is partial. ENABLEMENT example A9" });
  }
  if (kind === "history") {
    const rows = (await queryAll(`hist#${sid}`)).map(unmarshalFlat).map(r => ({ date: r.sk, courseId: numish(r.courseId), courseName: r.courseName, progress: r.progress, xpRemaining: r.xpRemaining, completed: r.completed || null, startDate: r.startDate || null, grade: r.grade, letterGrade: r.letterGrade || null, estimatedScore: r.estimatedScore || null, deactivated: r.deactivated, state: r.state, agreement: r.agreement, tbCourseIds: JSON.parse(r.tbCourseIds || "[]") })).sort((a, b) => a.date < b.date ? -1 : 1);
    return resp(200, { sourcedId: sid, ...fresh, nights: rows.length, firstNight: rows[0]?.date || null, lastNight: rows.at(-1)?.date || null, history: rows, note: "one row per DATE (the last snapshot of that date wins) since storeBegan; a course change shows as a different courseId between two dates and the last row of the old course carries its completed date if Math Academy had set it by then; nothing before storeBegan is known here (Timeback's results hold that half: ENABLEMENT A9)" });
  }
  if (kind === "activity") {
    const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    const from = q.from || "0000-00-00", to = q.to || "9999-12-31";
    if ((q.from && !isDay(q.from)) || (q.to && !isDay(q.to))) return resp(400, { error: "from and to must be real calendar days, YYYY-MM-DD (America/Chicago days); both optional" });
    if (from > to) return resp(400, { error: "from is after to" });
    const tasks = (await queryAll(`act#${sid}`, { cond: " AND sk BETWEEN :a AND :b", vals: { ":a": S(from + "#"), ":b": S(to + "#~") } })).map(unmarshalFlat).map(r => ({ date: r.sk.split("#")[0], taskId: numish(r.taskId), type: r.type, xp: r.xp, xpAwarded: r.xpAwarded, questions: r.questions, questionsCorrect: r.questionsCorrect, startedEpochMs: r.startedEpochMs ?? r.started, completedEpochMs: r.completedEpochMs ?? r.completed, courseId: numish(r.courseId), courseName: r.courseName, topicId: numish(r.topicId), topicName: numish(r.topicName) === null ? null : r.topicName, timeElapsedMs: r.timeElapsedMs ?? r.timeElapsed, timeEngagedMs: r.timeEngagedMs ?? r.timeEngaged, timeProductiveMs: r.timeProductiveMs ?? r.timeProductive }));
    const days = (await queryAll(`actday#${sid}`, { cond: " AND sk BETWEEN :a AND :b", vals: { ":a": S(from), ":b": S(to) } })).map(unmarshalFlat).map(r => ({ date: r.sk, numTasks: r.numTasks, timeElapsedMs: r.timeElapsedMs ?? r.timeElapsed, timeEngagedMs: r.timeEngagedMs ?? r.timeEngaged, timeProductiveMs: r.timeProductiveMs ?? r.timeProductive, xpAwarded: r.xpAwarded, questions: r.questions, questionsCorrect: r.questionsCorrect, windowUtc: r.windowUtc || null, error: r.error || null, fetchedAt: r.fetchedAt }));
    let stuRow = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) } }));
    let backfill = null;
    if (stuRow.Item && stuRow.Item.maId?.S && !stuRow.Item.backfilledAt && (await maKey())) {
      // first ask for this student's activity: pull their whole Math Academy history once (about five calls), then serve
      backfill = await backfillStudentActivity(sid, stuRow.Item.maId.S);
      const again = await queryAll(`act#${sid}`, { cond: " AND sk BETWEEN :a AND :b", vals: { ":a": S(from + "#"), ":b": S(to + "#~") } });
      tasks.length = 0; for (const it of again.map(unmarshalFlat)) tasks.push({ date: it.sk.split("#")[0], taskId: numish(it.taskId), type: it.type, xp: it.xp, xpAwarded: it.xpAwarded, questions: it.questions, questionsCorrect: it.questionsCorrect, startedEpochMs: it.startedEpochMs ?? it.started, completedEpochMs: it.completedEpochMs ?? it.completed, courseId: numish(it.courseId), courseName: it.courseName, topicId: numish(it.topicId), topicName: numish(it.topicName) === null ? null : it.topicName, timeElapsedMs: it.timeElapsedMs ?? it.timeElapsed, timeEngagedMs: it.timeEngagedMs ?? it.timeEngaged, timeProductiveMs: it.timeProductiveMs ?? it.timeProductive });
      const againDays = await queryAll(`actday#${sid}`, { cond: " AND sk BETWEEN :a AND :b", vals: { ":a": S(from), ":b": S(to) } });
      days.length = 0; for (const it of againDays.map(unmarshalFlat)) days.push({ date: it.sk, numTasks: it.numTasks, timeElapsedMs: it.timeElapsedMs ?? it.timeElapsed, timeEngagedMs: it.timeEngagedMs ?? it.timeEngaged, timeProductiveMs: it.timeProductiveMs ?? it.timeProductive, xpAwarded: it.xpAwarded, questions: it.questions, questionsCorrect: it.questionsCorrect, windowUtc: it.windowUtc || null, error: it.error || null, fetchedAt: it.fetchedAt });
      stuRow = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) } }));
    }
    let daysRequested = null;
    if (q.from && q.to) {
      const a = new Date(q.from + "T00:00:00Z"), b = new Date(q.to + "T00:00:00Z"); const span = Math.round((b - a) / 864e5);
      if (span >= 0 && span <= 90) {
        const byDate = Object.fromEntries(days.map(d => [d.date, d])); const began = fresh.storeBegan.slice(0, 10); const last = meta.activityLastDate || "";
        daysRequested = [];
        for (let i = 0; i <= span; i++) {
          const day = new Date(a.getTime() + i * 864e5).toISOString().slice(0, 10); const row = byDate[day];
          const todayChi = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
          daysRequested.push({ date: day, status: row ? (row.error ? "error" : (day >= todayChi ? "pulled (today, partial: the day is not over)" : "pulled")) : (!stuRow.Item?.maId ? "no Math Academy record for this student under this organisation's key: nothing to pull" : stuRow.Item?.backfilledAt ? (day === meta.activityLastDate ? "no row yet on the newest pulled day: Timeback rows ingested after the nightly pull (3 to 8 percent of a day's rows; a student whose rows were ALL late was not selected) are picked up by tonight's re-pull, so this is NOT a confirmed zero until the day after" : day >= (stuRow.Item.backfilledFrom?.S || "2025-07-01") && day <= (meta.activityLastDate || day) ? "no Math Academy task that day (backfilled range)" : day > (meta.activityLastDate || "") ? "not pulled yet (after activityLastDate)" : "before the backfilled range") : day < "2026-09-15" ? "before the activity store began (2026-09-15); read this route once more, the first ask backfills the student" : day >= todayChi ? "today: not pulled until tonight's 03:45 run; read Timeback's results (Part B2) for today" : day > last ? "not pulled yet (after activityLastDate; tonight's run covers it)" : "no Math Academy result in Timeback for this student that day, nothing to pull"), numTasks: row?.numTasks ?? null, error: row?.error || null });
        }
      }
    }
    const reasonIfEmpty = days.length ? null : !stuRow.Item ? "this student has no store row (no Math Academy id known), so no activity day could be pulled; read /store/student/{sourcedId} first" : stuRow.Item.backfilledAt ? `this student's Math Academy activity is fully backfilled from ${stuRow.Item.backfilledFrom?.S || "2025-07-01"} to activityLastDate (${meta.activityLastDate || "none yet"}); no day in ${from}..${to} had a Math Academy task (days after activityLastDate are not pulled yet)` : `no day in ${from}..${to} was pulled for this student: either no Math Academy result in Timeback on those America/Chicago days, or the day is before the activity store began (2026-09-15), or after activityLastDate (${meta.activityLastDate || "none yet"})`;
    const coverage = stuRow.Item?.backfilledAt ? { backfilledAt: stuRow.Item.backfilledAt.S, backfilledFrom: stuRow.Item.backfilledFrom?.S || "2025-07-01", note: (JSON.parse(stuRow.Item.ma?.S || "{}").deactivated ? "this Math Academy account is DEACTIVATED: its activity pull can miss days that Timeback still holds (the student's events may come from another Math Academy account); compare with Timeback before reading an absent day as no work; " : "") + "this student's whole Math Academy activity has been pulled from backfilledFrom on; a day absent after that is a day with no Math Academy task on THIS Math Academy account (a student whose Timeback events come from a second account, or whose account is deactivated, is the exception: Timeback then holds tasks the store never saw)" } : { backfilledAt: null, note: "only nightly-pulled days for this student so far" };
    return resp(200, { sourcedId: sid, ...fresh, backfilledNow: backfill, coverage, reasonIfEmpty, daysRequested, daysRequestedNote: daysRequested ? null : "daysRequested[] is served only when both from and to are given and the range is 90 days or fewer; ask in slices for a per-day status", from, to, dayBoundary: "America/Chicago; each day is the UTC window in days[].windowUtc, tasks kept by their Math Academy completion time", units: "every clock and epoch here is MILLISECONDS (task and day alike); divide by 60000 for minutes", activityLastDate: meta.activityLastDate || null, days, tasks, note: "Math Academy's own per-task analysis by America/Chicago day; for a backfilled student (coverage.backfilledAt set) a day absent between backfilledFrom and activityLastDate is a day with no Math Academy task; for a student not yet backfilled an absent day was simply not pulled (nightly pulls cover only students with a Timeback result that day); a day after activityLastDate is not pulled yet; the current day is partial; daysRequested[] gives the status per day; ENABLEMENT A2" });
  }
  if (kind === "knowledge") {
    const row = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("student"), sk: S(sid) } }));
    if (!row.Item) return resp(404, { error: "student not in the store; read /store/student/{sourcedId} first (it makes a live lookup on a miss)" });
    const ma = JSON.parse(row.Item.ma.S); const courseId = q.courseId || ma.currentCourse?.id; const maId = row.Item.maId?.S || ma.id;
    if (!courseId) return resp(404, { error: "Math Academy shows no current course for this student" });
    const cached = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S(`know#${sid}`), sk: S(String(courseId)) } }));
    const ageOk = cached.Item && Date.now() - Date.parse(cached.Item.fetchedAt.S) < 7 * 864e5;
    if (cached.Item?.notFound?.BOOL && Date.now() - Date.parse(cached.Item.fetchedAt.S) < 864e5 && !q.refresh) return resp(404, { error: "Math Academy has no knowledge map for this student and course id (cached answer from fetchedAt; 404s are kept 24 h so a loop does not spend a call per miss)", mathAcademyStatus: 404, fromCache: true, fetchedAt: cached.Item.fetchedAt.S, studentCurrentCourseId: ma.currentCourse?.id ?? null });
    if (cached.Item && !cached.Item.notFound?.BOOL && ageOk && !q.refresh) return resp(200, { sourcedId: sid, snapshotAt: meta.snapshotAt, stale: meta.stale, courseId: String(courseId), fetchedAt: cached.Item.fetchedAt.S, fromCache: true, knowledge: withRequested(JSON.parse(cached.Item.knowledge.S), courseId), note: "cached for 7 days per courseId; ?refresh=1 forces one live Math Academy call; the prerequisite courses are already inside courses[]" });
    const live = await maGet(`/students/${encodeURIComponent(maId)}/courses/${encodeURIComponent(courseId)}/knowledge`);
    await bumpRead("readMaKnowledge");
    if (live.status === 404) { await ddb.send(new PutItemCommand({ TableName: ST, Item: { pk: S(`know#${sid}`), sk: S(String(courseId)), fetchedAt: S(new Date().toISOString()), notFound: { BOOL: true } } })); return resp(404, { error: "Math Academy has no knowledge map for this student and course id (wrong courseId, or a course the student never held); this 404 cost one Math Academy call and is cached for 24 h", mathAcademyStatus: 404, studentCurrentCourseId: ma.currentCourse?.id ?? null }); }
    if (live.status === 429) return resp(429, { error: "Math Academy's fair-use limit answered 429; try later, do not loop this route", mathAcademyStatus: 429, cachedAvailable: !!cached.Item });
    if (live.status !== 200 || !live.body) return resp(live.status === 0 ? 503 : 502, { error: "Math Academy did not return the knowledge map", mathAcademyStatus: live.status, detail: live.error || null, cachedAvailable: !!cached.Item });
    const now = new Date().toISOString(); const know = live.body.courses ? { courses: live.body.courses } : live.body;
    withRequested(know, courseId);
    await ddb.send(new PutItemCommand({ TableName: ST, Item: { pk: S(`know#${sid}`), sk: S(String(courseId)), fetchedAt: S(now), knowledge: S(JSON.stringify(know)) } }));
    return resp(200, { sourcedId: sid, snapshotAt: meta.snapshotAt, stale: meta.stale, courseId: String(courseId), fetchedAt: now, fromCache: false, knowledge: know, note: "one live Math Academy call was made for this map; cached for 7 days PER courseId (the prerequisite courses are already inside courses[], so asking for them by courseId spends another call for nothing); each unit/module/topic carries stability 0-1 (long-term retention); the requested course is usually the LAST element of courses[] (prerequisites first): use requestedCourse or match on id, and note courses[].id is a number while courseId here is a string; a stability of exactly 0 means Math Academy has no current retention evidence: untaught topics AND topics that were just failed both read 0 (open question, ticket 19), so zeros with a Timeback task on record belong at the top of a weakest list, not off it; ENABLEMENT A10" });
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
    if (meta) {
      const problems = [];
      const nowChi = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
      const yday = new Date(nowChi); yday.setDate(yday.getDate() - 1); const ydayStr = yday.toISOString().slice(0, 10);
      const afterWindow = nowChi.getHours() >= 5;   // the 03:00 / 03:45 Central runs are done by 05:00
      if (meta.stale) problems.push(`stale: snapshot is ${meta.snapshotAgeHours} h old (limit ${meta.staleAfterDays * 24} h)`);
      if (afterWindow && meta.snapshotAgeHours > 30) problems.push("no snapshot since the last 03:00 Central window");
      if (afterWindow && meta.activityLastDate && meta.activityLastDate < ydayStr) problems.push(`activity not caught up: newest pulled day ${meta.activityLastDate}, expected ${ydayStr}`);
      if (meta.lastActivityRun && (meta.lastActivityRun.errors || 0) > 0) problems.push(`last activity run had ${meta.lastActivityRun.errors} student errors`);
      const warnings = [];
      if (meta.lastActivityRun && meta.lastActivityRun.noMaId > 0) (meta.lastActivityRun.noMaId > 20 ? problems : warnings).push(`${meta.lastActivityRun.noMaId} active students still without a Math Academy id after lookup (a data condition, not a store failure, unless it climbs above 20)`);
      if (!meta.schedule.firstScheduledRunHasHappened && nowChi >= new Date("2026-09-18T06:00:00")) problems.push("the scheduled 03:00 run has never fired");
      meta.health = { ok: problems.length === 0, checkedAt: new Date().toISOString(), problems, warnings, note: "computed from the fields on this response; the repo's daily health-check workflow opens a GitHub issue when ok is false" };
    }
    if (meta) {
      const auth = await tokenOk(event);
      if (!auth.ok) { delete meta.byCourse; meta.counts = { gated: "counts of students by course and agreement are served only with the reader's Timeback token (Authorization: Bearer <token>); freshness, schedule, health and calls are open" }; }
      meta.countsGated = !auth.ok;
    }
    return meta ? resp(200, { ...meta, routes: ["GET /store/student/{sourcedId}[?minimal=1]", "GET /store/student?email=", "GET /store/student/{sourcedId}/history", "GET /store/student/{sourcedId}/courses", "GET /store/finishers?since=YYYY-MM-DD[&mathAcademyCourseId=]", "GET /store/student/{sourcedId}/activity?from=&to=", "GET /store/student/{sourcedId}/knowledge[?courseId=&refresh=1]", "GET /store/course/{courseSourcedId}", "GET /store/course/{courseSourcedId}/students[?agreement=]  (token; ids + Math Academy course figures, no names)", "GET /store/course/{courseSourcedId}/activity?date=YYYY-MM-DD  (token; per-student day totals)", "GET /store/courses  (Math Academy course id -> name)"], gate: "everything about students, including the per-course counts and the counts on this page: Authorization: Bearer <reader's Timeback token>; open without a token: freshness, schedule, health, calls, routes, notes and /store/courses (Math Academy's course names)", mathAcademyCallsAtReadTime: "three cases reach Math Academy at read time, all counted in readCalls: (1) a per-student read of a student missing from the store, or of a student who left the roster, makes one live lookup once per 24 h; (2) the knowledge route makes one live call per courseId per 7 days (a 404 is cached for 24 h); (3) the FIRST /activity read of a student the backfill has not reached pulls their whole activity (about five calls, once; coverage.backfilledAt then set). /history, /store, the course routes and /store/courses never do", notes: STATUS_NOTES }) : resp(404, { error: "no snapshot loaded" });
  }
  const crsList = p.match(/^\/store\/course\/([^/]+)\/students$/);
  if (crsList && method === "GET") {
    const token = event.headers?.authorization || event.headers?.Authorization || "";
    if (!/^Bearer\s+\S+/i.test(token)) return resp(401, { error: "send the reader's Timeback token as Authorization: Bearer <token>" });
    const ok = await tbGet("/ims/oneroster/rostering/v1p2/users/?limit=1", token);
    if (ok.status !== 200) return resp(ok.status === 401 || ok.status === 403 ? ok.status : 502, { error: "Timeback did not accept the token", timebackStatus: ok.status });
    const meta = await storeMeta(); if (!meta) return resp(503, { error: "no snapshot loaded" });
    const cid = decodeURIComponent(crsList[1]); const want = q.agreement || null;
    if (!meta.byCourse[cid]) return resp(404, { error: "no roster student sat in that Timeback course at snapshot time (or unknown course id)", snapshotAt: meta.snapshotAt });
    if (want && !AGREEMENT_VALUES.includes(want)) return resp(400, { error: "unknown agreement value", allowed: AGREEMENT_VALUES });
    const rows = [];
    for (const it of await queryAll("student")) { const seats = JSON.parse(it.seats?.S || "[]"); if (!seats.some(s => s.courseSourcedId === cid)) continue; const ag = it.courseAgreementAtSnapshot?.S; if (want && ag !== want) continue; const ma = JSON.parse(it.ma?.S || "{}"); const cc = ma.currentCourse || {}; rows.push({ sourcedId: it.sk.S, courseAgreementAtSnapshot: ag, matchedBy: it.matchedBy?.S, matchConfidence: it.matchedBy?.S === "name" ? "low" : "high", isTestUser: it.isTestUser?.BOOL ?? null, isLikelyTest: it.isLikelyTest?.BOOL ?? (it.isTestUser?.BOOL ?? null), classSourcedIds: seats.filter(s => s.courseSourcedId === cid).map(s => s.classSourcedId), seatBeginDates: seats.filter(s => s.courseSourcedId === cid).map(s => s.beginDate || null), currentSeatCount: new Set(seats.map(s => s.courseSourcedId)).size, grades: JSON.parse(it.grades?.S || "null"), mathAcademyState: maState(cc), mathAcademyCourseId: cc.id ?? null, mathAcademyCourseName: cc.name ?? null, progress: cc.progress ?? null, xpRemaining: cc.xpRemaining ?? null, xpRemainingReading: xpReading(cc), completed: cc.completed ?? null, startDate: cc.startDate ?? null, estimatedScore: cc.estimatedScore ?? null, deactivated: ma.deactivated ?? null, figuresAsOf: it.snapshotAt?.S || meta.snapshotAt }); }
    if (!want || want === "no math academy record") for (const it of await queryAll("tb_unmatched")) { const seats = JSON.parse(it.seats?.S || "[]"); if (!seats.some(s => s.courseSourcedId === cid)) continue; rows.push({ sourcedId: it.sk.S, courseAgreementAtSnapshot: "no math academy record", unmatchedReason: it.reason?.S || null, lastTriedAt: it.lastTriedAt?.S || null, matchedBy: null, matchConfidence: null, isTestUser: it.isTestUser?.BOOL ?? null, isLikelyTest: it.isLikelyTest?.BOOL ?? (it.isTestUser?.BOOL ?? null), classSourcedIds: seats.filter(s => s.courseSourcedId === cid).map(s => s.classSourcedId), seatBeginDates: seats.filter(s => s.courseSourcedId === cid).map(s => s.beginDate || null), currentSeatCount: new Set(seats.map(s => s.courseSourcedId)).size, grades: JSON.parse(it.grades?.S || "null"), mathAcademyState: "no math academy record", mathAcademyCourseId: null, mathAcademyCourseName: null, progress: null, xpRemaining: null, completed: null, startDate: null, estimatedScore: null, deactivated: null, figuresAsOf: null }); }
    const nonTest = rows.filter(r => r.isLikelyTest === false).length;
    return resp(200, { courseSourcedId: cid, snapshotAt: meta.snapshotAt, stale: meta.stale, filter: want, count: rows.length, nonTestCount: nonTest, students: rows.length, rows, note: "one row per roster student of this Timeback course at rosterReadAt: opaque user.sourcedId, store labels, Math Academy's course figures (no names), classSourcedIds (the section(s) in this course), isTestUser (Timeback's flag) and isLikelyTest (the flag OR a synthetic naming pattern OR a test campus, judged in the store so you never read names; nonTestCount uses it); `students` is the same COUNT as `count` (kept for old readers), the list is `rows`. Values for ?agreement=: " + AGREEMENT_VALUES.join(" | ") + ". A cohort with figures is this one call; resolve a single row with /store/student/{sourcedId}." });
  }
  const crsAct = p.match(/^\/store\/course\/([^/]+)\/activity$/);
  if (crsAct && method === "GET") {
    const token = event.headers?.authorization || event.headers?.Authorization || "";
    if (!/^Bearer\s+\S+/i.test(token)) return resp(401, { error: "send the reader's Timeback token as Authorization: Bearer <token>" });
    const ok = await tbGet("/ims/oneroster/rostering/v1p2/users/?limit=1", token);
    if (ok.status !== 200) return resp(ok.status >= 400 && ok.status < 500 ? ok.status : 502, { error: "Timeback did not accept the token", timebackStatus: ok.status });
    const meta = await storeMeta(); if (!meta) return resp(503, { error: "no snapshot loaded" });
    const day = q.date; if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day)) || new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day) return resp(400, { error: "give ?date=YYYY-MM-DD, a real calendar day (an America/Chicago day the store has pulled; see activityLastDate)" });
    const cid = decodeURIComponent(crsAct[1]);
    if (!meta.byCourse[cid]) return resp(404, { error: "no roster student sat in that Timeback course at snapshot time (or unknown course id)", snapshotAt: meta.snapshotAt });
    const todayChiC = chicagoDay(Date.now());
    if (day > todayChiC) return resp(200, { courseSourcedId: cid, date: day, dayStatus: "future: that day has not happened yet in America/Chicago", dayBoundary: "America/Chicago", windowUtc: chicagoWindowUtc(day), activityLastDate: meta.activityLastDate || null, snapshotAt: meta.snapshotAt, stale: meta.stale, rows: [], totals: null, note: "that day has not happened yet in America/Chicago" });
    const partialDay = day > (meta.activityLastDate || "");
    const members = [];
    for (const it of await queryAll("student")) { const seats = JSON.parse(it.seats?.S || "[]"); if (seats.some(s => s.courseSourcedId === cid)) members.push({ sid: it.sk.S, isTestUser: it.isTestUser?.BOOL ?? null, isLikelyTest: it.isLikelyTest?.BOOL ?? (it.isTestUser?.BOOL ?? null), backfilled: !!it.backfilledAt }); }
    const backfilledN = members.filter(m => m.backfilled).length;
    const out = [];
    for (let i = 0; i < members.length; i += 100) {
      const chunk = members.slice(i, i + 100);
      const r = await ddb.send(new BatchGetItemCommand({ RequestItems: { [ST]: { Keys: chunk.map(m => ({ pk: S(`actday#${m.sid}`), sk: S(day) })) } } }));
      for (const it of (r.Responses?.[ST] || [])) { const f = unmarshalFlat(it); const sid = f.pk.slice(7); const m = chunk.find(x => x.sid === sid); out.push({ sourcedId: sid, isTestUser: m?.isTestUser ?? null, isLikelyTest: m?.isLikelyTest ?? m?.isTestUser ?? null, numTasks: f.numTasks ?? null, timeElapsedMs: f.timeElapsedMs ?? f.timeElapsed ?? null, timeEngagedMs: f.timeEngagedMs ?? f.timeEngaged ?? null, timeProductiveMs: f.timeProductiveMs ?? f.timeProductive ?? null, xpAwarded: f.xpAwarded ?? null, questions: f.questions ?? null, questionsCorrect: f.questionsCorrect ?? null, byType: f.byType ? JSON.parse(f.byType) : null, lessons: f.lessons ?? null, lessonsNegative: f.lessonsNegative ?? null, lessonsZero: f.lessonsZero ?? null, error: f.error || null }); }
    }
    const good = out.filter(r => !r.error && r.numTasks); const sum = k => good.reduce((a, r) => a + (r[k] || 0), 0);
    const rosterCount = meta.byCourse[cid]?.students ?? null;
    return resp(200, { courseSourcedId: cid, date: day, source: partialDay ? "on-demand or batch, incomplete" : (day >= "2026-09-15" ? "nightly" : "backfill batch"), dayStatus: partialDay ? (day === todayChiC ? "today: the store holds nothing for the current day until tonight's 03:45 pull (only a first-time on-demand backfill of a student writes today's rows); for today read Timeback's results container (ENABLEMENT Part B7)" : "not pulled yet: after activityLastDate; tonight's pull covers it") : "pulled", dayBoundary: "America/Chicago", windowUtc: chicagoWindowUtc(day), units: "milliseconds", activityLastDate: meta.activityLastDate || null, snapshotAt: meta.snapshotAt, stale: meta.stale, coverage: { studentsBackfilled: backfilledN, studentsNotBackfilled: members.length - backfilledN, note: partialDay ? "partial day (the current day, or a day the nightly has not pulled): rows here come from the backfill batch or from on-demand reads; the nightly pull completes the day, then pulledAt is set" : day < "2026-09-15" ? "this day is before the nightly activity store began (2026-09-15): rows exist ONLY for backfilled students, so a class total here covers studentsBackfilled of studentsWithStoreRow; if studentsNotBackfilled is not 0, the class figure is partial and you should say so (the per-student /activity route backfills a student on first ask)" : "nightly-pulled day: every roster student with a Timeback result that day AS OF THE PULL TIME (see pulledAt) was pulled, backfilled or not; results Timeback ingests after the pull (late Caliper rows, a few per estate-day) land on the next night's re-pull of this day, so a day can grow by a student or two until the night after next" }, pulledAt: partialDay ? null : (day >= "2026-09-15" ? (meta.lastActivityRun?.finishedAt || null) : null), pulledAtNote: partialDay ? "partial day: not pulled by a nightly run yet" : (day >= "2026-09-15" ? "the finish time of the newest nightly activity run; days before the newest pulled day were completed on earlier nights or by the backfill batch" : "before the nightly activity store began: rows come from the backfill batch of 2026-09-17/18, not from a nightly pull"), rosterStudents: rosterCount, rosterNonTest: meta.byCourse[cid]?.nonTest?.students ?? null, studentsWithStoreRow: members.length, rosterWithoutMathAcademyRecord: rosterCount === null ? null : rosterCount - members.length, studentsWithActivity: good.length, studentsWithError: out.length - good.length, totals: { numTasks: sum("numTasks"), timeElapsedMs: sum("timeElapsedMs"), timeEngagedMs: sum("timeEngagedMs"), timeProductiveMs: sum("timeProductiveMs"), xpAwarded: sum("xpAwarded"), questions: sum("questions"), questionsCorrect: sum("questionsCorrect"), lessons: sum("lessons"), lessonsNegative: sum("lessonsNegative"), lessonsZero: sum("lessonsZero"), byType: good.reduce((a, r) => { for (const [k, v] of Object.entries(r.byType || {})) a[k] = (a[k] || 0) + v; return a; }, {}), rowsWithoutTypeMix: good.filter(r => !r.byType).length }, rows: out, note: "one row per roster student of this Timeback course who had a pulled activity day on `date` (Math Academy's own per-task analysis summed by the store); rosterStudents is the course roster at rosterReadAt (test users included; rosterNonTest excludes them), studentsWithStoreRow those with a Math Academy record, and the denominator for 'share of my class active' is rosterNonTest; rows carry isLikelyTest so you can drop synthetic accounts; students absent from rows had no Math Academy result in Timeback that day, or (before 2026-09-15) were not yet backfilled: read coverage before quoting a class total; totals sum the rows without error; opaque ids only; ENABLEMENT A2" });
  }
  if (p === "/store/courses" && method === "GET") {
    const meta = await storeMeta(); if (!meta) return resp(404, { error: "no snapshot loaded" });
    let r; try { r = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("meta"), sk: S("snapshot") }, ProjectionExpression: "maCourses" })); } catch { r = {}; }
    return resp(200, { snapshotAt: meta.snapshotAt, stale: meta.stale, mathAcademyCourses: JSON.parse(r.Item?.maCourses?.S || "{}"), note: "Math Academy's own course id -> name, as seen on student records in the store (its catalogue vocabulary, not Timeback's course ids); the values in mathAcademyCourseId on the course student list and currentCourse.id on rows" });
  }
  const crs = p.match(/^\/store\/course\/([^/]+)$/);
  if (crs && method === "GET") {
    const auth = await tokenOk(event);
    if (!auth.ok) return resp(auth.status === 401 ? 401 : (auth.status >= 400 && auth.status < 500 ? auth.status : 502), { error: "per-course counts are served only with the reader's Timeback token (Authorization: Bearer <token>)", timebackStatus: auth.status === 401 ? undefined : auth.status });
    const meta = await storeMeta(); if (!meta) return resp(404, { error: "no snapshot loaded" });
    const c = meta.byCourse[decodeURIComponent(crs[1])];
    if (c) c.activityLastDate = meta.activityLastDate || null;
    if (!c) return resp(404, { error: "no roster student sat in that Timeback course at snapshot time (or unknown course id)", snapshotAt: meta.snapshotAt, knownCourses: Object.keys(meta.byCourse).length });
    return resp(200, { courseSourcedId: decodeURIComponent(crs[1]), ...c, snapshotAt: meta.snapshotAt, rosterReadAt: meta.rosterReadAt, snapshotAgeHours: meta.snapshotAgeHours, stale: meta.stale,
      note: "counts of roster students (current in-window seats in this course at rosterReadAt) by courseAgreementAtSnapshot; `students`, `byAgreement` and `maNotStarted` INCLUDE test users; `nonTest` carries the same counts for non-test students only, plus byMathAcademyState; maNotStarted = Math Academy progress 0 and not completed (course assigned, nothing done). No student values; the rows are one call away at /store/course/{id}/students with your token." });
  }
  if (p === "/store/finishers" && method === "GET") {
    const auth = await tokenOk(event);
    if (!auth.ok) return resp(auth.status === 401 ? 401 : (auth.status >= 400 && auth.status < 500 ? auth.status : 502), { error: "finishers are served only with the reader's Timeback token (Authorization: Bearer <token>)", timebackStatus: auth.status });
    const meta = await storeMeta(); if (!meta) return resp(503, { error: "no snapshot loaded" });
    const since = q.since || "2000-01-01";   // all time when omitted (Math Academy has stamped completed dates back to 2025); the recipe says which since to pass
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || isNaN(Date.parse(since))) return resp(400, { error: "give ?since=YYYY-MM-DD (a calendar day; Math Academy's completed timestamp is compared by its UTC date)" });
    if (q.mathAcademyCourseId !== undefined && !/^\d+$/.test(String(q.mathAcademyCourseId))) return resp(400, { error: "mathAcademyCourseId must be a Math Academy course id (a number; see /store/courses)" });
    const wantCourse = q.mathAcademyCourseId ? String(q.mathAcademyCourseId) : null;
    const rows = [];
    for (const it of await queryAll("student")) {
      const ma = JSON.parse(it.ma?.S || "{}"); const cc = ma.currentCourse || {}; if (!cc.id) continue;
      if (wantCourse && String(cc.id) !== wantCourse) continue;
      const completedDay = cc.completed ? String(cc.completed).slice(0, 10) : null; const at100 = !cc.completed && Number(cc.progress) >= 0.995;
      const seats = JSON.parse(it.seats?.S || "[]"); const offRoster = !!it.offRosterSince?.S && seats.length === 0;
      const nearOff = !cc.completed && offRoster && Number(cc.progress) >= 0.95 && Number(cc.progress) < 0.995;
      if (!(completedDay && completedDay >= since) && !at100 && !nearOff) continue;
      const bucket = cc.completed ? "completed" : at100 ? "at 100, not marked complete" : "left the roster near the end, not finished";
      const days = cc.startDate ? Math.round((Date.parse((cc.completed || meta.snapshotAt).slice(0, 10)) - Date.parse(String(cc.startDate).slice(0, 10))) / 864e5) : null;
      rows.push({ sourcedId: it.sk.S, bucket, mathAcademyCourseId: cc.id ?? null, mathAcademyCourseName: cc.name ?? null, completed: cc.completed ?? null, startDate: cc.startDate ?? null, daysInCourse: Number.isFinite(days) && days >= 0 ? days : null, startAfterCompleted: Number.isFinite(days) && days < 0 ? true : undefined, maId: it.maId?.S || null, progress: cc.progress ?? null, xpRemaining: cc.xpRemaining ?? null, mathAcademyState: maState(cc), courseAgreementAtSnapshot: it.courseAgreementAtSnapshot?.S || null, timebackCourseSourcedIds: [...new Set(seats.map(s => s.courseSourcedId))], offRosterSince: it.offRosterSince?.S || null, isTestUser: it.isTestUser?.BOOL ?? null, isLikelyTest: it.isLikelyTest?.BOOL ?? (it.isTestUser?.BOOL ?? null), matchedBy: it.matchedBy?.S || null, figuresAsOf: it.figuresAsOf?.S || it.snapshotAt?.S || null });
    }
    rows.sort((a, b) => String(b.completed || "9") < String(a.completed || "9") ? -1 : 1);
    // episode size in the finished course from the task rows: a completed with a handful of lessons is a placement pass-through, not a course worked through
    for (let i = 0; i < rows.length; i += 20) {
      await Promise.all(rows.slice(i, i + 20).map(async r => { try { const acts = await queryAll(`act#${r.sourcedId}`); const mine = acts.filter(a => String(a.courseId?.S) === String(r.mathAcademyCourseId)); r.tasksInCourse = mine.length; r.lessonsInCourse = mine.filter(a => /^lesson$/i.test(String(a.type?.S))).length; r.passThrough = r.bucket === "completed" && r.lessonsInCourse < 20 ? "likely a placement pass-through (under 20 lessons in the finished course): the real finish is the previous episode, see /courses" : null; } catch { r.tasksInCourse = null; r.lessonsInCourse = null; r.passThrough = null; } }));
    }
    for (const r of rows) delete r.maId;
    const finished = rows.filter(r => r.bucket !== "left the roster near the end, not finished");
    return resp(200, { since, mathAcademyCourseId: wantCourse ? Number(wantCourse) : null, snapshotAt: meta.snapshotAt, stale: meta.stale, count: rows.length, nonTestCount: rows.filter(r => !r.isLikelyTest).length, finishedCount: finished.length, finishedNonTestCount: finished.filter(r => !r.isLikelyTest).length, workedThroughNonTestCount: finished.filter(r => !r.isLikelyTest && !r.passThrough).length, countNote: "count and nonTestCount are ALL rows including the near-finisher bucket; finishedCount and finishedNonTestCount are the completed and at-100 buckets; workedThroughNonTestCount also drops the likely placement pass-throughs (under 20 lessons in the course)", byBucket: rows.reduce((a, r) => (a[r.bucket] = (a[r.bucket] || 0) + 1, a), {}), rows,
      bucketNote: "completed = Math Academy set the flag on or after since (read progress and daysInCourse beside it: a completed after a few days and a few tasks is a placement pass-through, not a course worked through; a completed under 0.9 is a course switch); at 100, not marked complete = progress >= 0.995 without the flag, served whatever the date; left the roster near the end, not finished = no current Timeback seat, progress 0.95 to 0.994, no flag: Timeback's rounded 100 progressed them out before Math Academy closed the course, so they appear in no course list and no day total",
      note: "Math Academy's OWN completion flag: every store row (current roster or not; every student who ever held a seat has a row since the backfill) whose CURRENT Math Academy course carries completed on or after `since` (UTC date of the timestamp), plus rows at progress >= 0.995 without a completed flag ('at 100, not marked complete'). Read progress beside completed: Math Academy has set completed at 69 to 81 percent on a course switch. NOT here: a student Math Academy has already moved to a new course (their finished course's completed date is gone from the current record; /history keeps it for nights since 2026-09-17, and Timeback's results hold the rounded 100, ENABLEMENT part B). timebackCourseSourcedIds [] with offRosterSince set = finished and left the Math Academy roster (progression moved them on; ENABLEMENT example A5 for the disposition). Opaque ids only. ENABLEMENT example A5" });
  }
  const sub = p.match(/^\/store\/student\/([^/]+)\/(history|activity|knowledge|courses)$/);
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
