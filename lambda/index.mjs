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
  return { snapshotAt: r.Item.snapshotAt?.S, apiVersion: r.Item.apiVersion?.S, calls: JSON.parse(r.Item.calls?.S || "{}"), counts: JSON.parse(r.Item.counts?.S || "{}") };
}
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
  const base = { sourcedId: sid, snapshotAt: meta?.snapshotAt || null, apiVersion: meta?.apiVersion || null, timeback: { currentMathAcademySeats: seats, readAt: new Date().toISOString(), enrollmentsStatus: enr.status } };
  if (!row.Item) {
    const un = await ddb.send(new GetItemCommand({ TableName: ST, Key: { pk: S("tb_unmatched"), sk: S(sid) } }));
    if (un.Item) return resp(200, { ...base, inSnapshot: false, matchedBy: null, unmatchedReason: un.Item.reason?.S, mathAcademy: null, courseAgreement: "no math academy record", note: "on the Timeback roster at snapshot time but no Math Academy record matched (HTTP 404 = no account under this organisation's key; HTTP 401 = account under another organisation's key; 'no email' = nothing to look up by)" });
    return resp(200, { ...base, inSnapshot: false, matchedBy: null, mathAcademy: null, courseAgreement: "not in snapshot", note: "not on the Timeback Math Academy roster at snapshot time and not looked up since; the snapshot is one-off (no refresh scheduled) and this route makes no Math Academy call" });
  }
  const ma = JSON.parse(row.Item.ma.S);
  const maCourse = ma.currentCourse?.name || null;
  const agreement = !maCourse ? "math academy has no current course" : seats.length === 0 ? "no current timeback seat" : seats.some(s => normCourse(s.courseName) === normCourse(maCourse)) ? "agree" : (ma.currentCourse?.completed ? "disagree, math academy course completed" : "disagree");
  return resp(200, { ...base, inSnapshot: true, matchedBy: row.Item.matchedBy?.S, isTestUser: row.Item.isTestUser?.BOOL ?? null, mathAcademy: ma, courseAgreement: agreement, courseAgreementAtSnapshot: row.Item.courseAgreementAtSnapshot?.S || null,
    seatsAtSnapshot: JSON.parse(row.Item.seats?.S || "[]"), note: "mathAcademy is Math Academy's own record as of snapshotAt (copied); timeback.currentMathAcademySeats is read live now with your token; courseAgreement compares the two by normalised course title" });
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
    return meta ? resp(200, { ...meta, routes: ["GET /store/student/{sourcedId}", "GET /store/student?email="], gate: "Authorization: Bearer <reader's Timeback token>", refresh: "none scheduled; one-off snapshot" }) : resp(404, { error: "no snapshot loaded" });
  }
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
