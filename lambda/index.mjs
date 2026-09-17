// mathacademy_timeback front — AWS Lambda (Node.js 20, function URL, payload format 2.0).
//   GET /  |  /skill                                  -> skill.json
//   GET /DICTIONARY.md | /ENABLEMENT.md | /reference/<file>.json   -> bundled files + X-Doc-SHA256 / X-Doc-Version
//   GET /feedback[?state=open|closed|all]              -> plain JSON array: this skill's tickets (its own tracker, a DynamoDB table)
//   GET /feedback/{n}                                  -> one ticket with its thread
//   POST /feedback {title, body, reporter, kind?}      -> 201 {number, url}  (no credential)
//   POST /feedback/{n}/admin {state?, githubUrl?, comment?}  with header x-admin-key -> 200  (the GitHub mirror job uses this)
// Env: TABLE, SOURCE, GIT_VERSION, ADMIN_KEY, MIRROR_REPO (owner/name, informational).
import { readFileSync, existsSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";

const CAPS = { title: 200, body: 10000 };
const SOURCE = process.env.SOURCE || "mathacademy_timeback";
const LABELS = ["skill-feedback", SOURCE];
const PUBLIC = process.env.LAMBDA_TASK_ROOT ? `${process.env.LAMBDA_TASK_ROOT}/public` : "./public";
const ddb = new DynamoDBClient({});
const T = process.env.TABLE;

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
  if (method === "OPTIONS") return { statusCode: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,x-admin-key" }, body: "" };

  if (method === "GET" || method === "HEAD") {
    if (p === "/" || p === "/skill") return serveFile("skill.json", "application/json; charset=utf-8", method);
    if (p === "/DICTIONARY.md" || p === "/ENABLEMENT.md") return serveFile(p.slice(1), "text/markdown; charset=utf-8", method);
    if (p.startsWith("/reference/") && p.endsWith(".json")) return serveFile(p.slice(1), "application/json; charset=utf-8", method);
  }
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
  return resp(404, { error: "not found", routes: ["GET /skill", "GET /DICTIONARY.md", "GET /ENABLEMENT.md", "GET /reference/<file>.json", "GET /feedback[?state=]", "GET /feedback/{n}", "POST /feedback"] });
};
