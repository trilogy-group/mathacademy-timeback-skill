// mathacademy_timeback front — AWS Lambda (Node.js 20, function URL, payload format 2.0).
// Same routes as feedback/worker.js:
//   GET /  |  /skill                -> skill.json
//   GET /DICTIONARY.md | /ENABLEMENT.md | /reference/<file>.json   -> bundled files + X-Doc-SHA256 / X-Doc-Version
//   GET /feedback[?state=open|closed|all]  -> plain JSON array reflecting the GitHub tracker
//   GET /feedback/{n}               -> one ticket with comments
//   POST /feedback {title, body, reporter, kind?} -> 201 {number, url}
// Env: REPO (owner/name), SOURCE, SECRET_NAME, SECRET_KEY (key inside the JSON secret holding a GitHub token), GIT_VERSION.
// The token is read from Secrets Manager at cold start and cached; it is never logged.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const CAPS = { title: 200, body: 10000 };
const LABELS = ["skill-feedback", process.env.SOURCE || "mathacademy_timeback"];
const PUBLIC = process.env.LAMBDA_TASK_ROOT ? `${process.env.LAMBDA_TASK_ROOT}/public` : "./public";
let tokenPromise = null;
async function token() {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const sm = new SecretsManagerClient({});
      const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME }));
      const j = JSON.parse(r.SecretString || "{}");
      const t = j[process.env.SECRET_KEY || "GITHUB_TOKEN"];
      if (!t) throw new Error("token key missing in secret");
      return t;
    })().catch(e => { tokenPromise = null; throw e; });
  }
  return tokenPromise;
}
const resp = (status, body, headers = {}) => ({
  statusCode: status,
  headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body, null, 1),
});
async function gh(path, init = {}) {
  // Reads work keyless on a public tracker; the token is used when it can be read, and is required for writes.
  const base = { accept: "application/vnd.github+json", "user-agent": "mathacademy_timeback-front", "x-github-api-version": "2022-11-28" };
  let t = null;
  try { t = await token(); } catch (e) { if ((init.method || "GET") !== "GET") throw e; }
  const call = (auth) => fetch(`https://api.github.com${path}`, { ...init, headers: { ...base, ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(init.headers || {}) } });
  let r = await call(t);
  // a scoped token that cannot see this repo answers 404/403 on reads; retry keyless before giving up
  if ((init.method || "GET") === "GET" && t && (r.status === 404 || r.status === 403)) r = await call(null);
  return r;
}
const view = i => ({ number: i.number, title: i.title, state: i.state, createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at, labels: (i.labels || []).map(l => l.name), comments: i.comments, url: i.html_url });
function serveFile(rel, ct, method) {
  const safe = rel.replace(/\.\./g, "");
  const p = `${PUBLIC}/${safe}`;
  if (!existsSync(p)) return resp(404, { error: "not found" });
  const buf = readFileSync(p);
  const sha = createHash("sha256").update(buf).digest("hex");
  return { statusCode: 200, headers: { "content-type": ct, "x-doc-sha256": sha, "x-doc-version": process.env.GIT_VERSION || "unversioned", "access-control-allow-origin": "*", "cache-control": "no-store" }, body: method === "HEAD" ? "" : buf.toString("utf-8") };
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const p = (event.rawPath || "/").replace(/\/+$/, "") || "/";
  const q = event.queryStringParameters || {};
  if (method === "OPTIONS") return { statusCode: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }, body: "" };

  if (method === "GET" || method === "HEAD") {
    if (p === "/" || p === "/skill") return serveFile("skill.json", "application/json; charset=utf-8", method);
    if (p === "/DICTIONARY.md" || p === "/ENABLEMENT.md") return serveFile(p.slice(1), "text/markdown; charset=utf-8", method);
    if (p.startsWith("/reference/") && p.endsWith(".json")) return serveFile(p.slice(1), "application/json; charset=utf-8", method);
  }
  if (p === "/feedback" && method === "GET") {
    const state = "state" in q ? q.state : "open";
    if (!["open", "closed", "all"].includes(state)) return resp(400, { error: "state must be open|closed|all" });
    const out = []; let page = 1;
    try {
      while (page <= 10) {
        const r = await gh(`/repos/${process.env.REPO}/issues?state=${state}&labels=${LABELS.join(",")}&per_page=100&page=${page}`);
        if (!r.ok) return resp(502, { error: "tracker read failed", status: r.status });
        const items = (await r.json()).filter(i => !i.pull_request);
        out.push(...items.map(view));
        if (items.length < 100) break; page++;
      }
    } catch (e) { return resp(502, { error: "tracker read failed", detail: String(e.message || e) }); }
    return resp(200, out, { "x-state-applied": state, "x-total-count": String(out.length) });
  }
  const one = p.match(/^\/feedback\/(\d+)$/);
  if (one && method === "GET") {
    const r = await gh(`/repos/${process.env.REPO}/issues/${one[1]}`);
    if (r.status === 404) return resp(404, { error: "not found" });
    if (!r.ok) return resp(502, { error: "tracker read failed", status: r.status });
    const i = await r.json();
    if (!(i.labels || []).some(l => l.name === LABELS[0])) return resp(404, { error: "not a skill-feedback ticket" });
    const c = await gh(`/repos/${process.env.REPO}/issues/${one[1]}/comments?per_page=100`);
    const comments = c.ok ? (await c.json()).map(x => ({ author: x.user?.login, createdAt: x.created_at, body: x.body })) : [];
    return resp(200, { ...view(i), body: i.body, comments });
  }
  if (p === "/feedback" && method === "POST") {
    let b;
    try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf-8") : (event.body || "")); }
    catch { return resp(400, { error: "body must be JSON {title, body, reporter, kind?}" }); }
    const { title, body, reporter, kind } = b || {};
    if (!title || !body || !reporter) return resp(400, { error: "title, body and reporter are required" });
    if (String(title).length > CAPS.title) return resp(413, { error: `title over ${CAPS.title} characters` });
    if (String(body).length > CAPS.body) return resp(413, { error: `body over ${CAPS.body} characters` });
    const issueBody = `reporter: ${reporter}\nkind: ${kind || "report"}\nsource: ${process.env.SOURCE}\n\n${body}`;
    const r = await gh(`/repos/${process.env.REPO}/issues`, { method: "POST", body: JSON.stringify({ title: String(title), body: issueBody, labels: LABELS }) });
    if (!r.ok) return resp(502, { error: "tracker write failed", status: r.status });
    const i = await r.json();
    return resp(201, { number: i.number, url: i.html_url, covers: "this skill's documents, front and reference files" });
  }
  return resp(404, { error: "not found", routes: ["GET /skill", "GET /DICTIONARY.md", "GET /ENABLEMENT.md", "GET /reference/<file>.json", "GET /feedback[?state=]", "GET /feedback/{n}", "POST /feedback"] });
};
