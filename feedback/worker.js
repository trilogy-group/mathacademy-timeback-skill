// mathacademy_timeback front — Cloudflare Worker.
// Serves: GET /skill (and /) -> skill.json; GET /DICTIONARY.md, /ENABLEMENT.md, /reference/* -> static assets with
// X-Doc-SHA256 / X-Doc-Version headers; GET /feedback[?state=open|closed|all] -> plain JSON array of issues;
// GET /feedback/{n} -> one issue with comments; POST /feedback {title, body, reporter, kind?} -> 201 {number, url}.
// Secrets: GITHUB_TOKEN (issues:write on REPO). Vars: REPO ("owner/name"), SOURCE ("mathacademy_timeback").
// Static files are bound as ASSETS (wrangler [assets]).

const CAPS = { title: 200, body: 10000 };
const LABELS = ["skill-feedback", "mathacademy_timeback"];

async function sha256hex(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...extra } });
}
async function gh(env, path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { "authorization": `Bearer ${env.GITHUB_TOKEN}`, "accept": "application/vnd.github+json", "user-agent": "mathacademy_timeback-front", "x-github-api-version": "2022-11-28", ...(init.headers || {}) },
  });
  return r;
}
function issueView(i) {
  return { number: i.number, title: i.title, state: i.state, createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at, labels: (i.labels || []).map(l => l.name), comments: i.comments, url: i.html_url };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" } });

    // ---- front + documents (static assets) -------------------------------------------------
    if (req.method === "GET" || req.method === "HEAD") {
      if (p === "/" || p === "/skill") {
        const a = await env.ASSETS.fetch(new Request(new URL("/skill.json", url).toString()));
        const body = await a.arrayBuffer();
        return new Response(req.method === "HEAD" ? null : body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", "content-length": String(body.byteLength) } });
      }
      if (p === "/DICTIONARY.md" || p === "/ENABLEMENT.md" || p.startsWith("/reference/")) {
        const a = await env.ASSETS.fetch(new Request(new URL(p, url).toString()));
        if (a.status !== 200) return json({ error: "not found" }, 404);
        const body = await a.arrayBuffer();
        const sha = await sha256hex(body);
        const ct = p.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8";
        return new Response(req.method === "HEAD" ? null : body, { status: 200, headers: { "content-type": ct, "x-doc-sha256": sha, "x-doc-version": env.GIT_VERSION || "unversioned", "access-control-allow-origin": "*", "cache-control": "no-store", "content-length": String(body.byteLength) } });
      }
    }

    // ---- feedback wire ------------------------------------------------------------------------
    if (p === "/feedback" && req.method === "GET") {
      const state = url.searchParams.has("state") ? url.searchParams.get("state") : "open";
      if (!["open", "closed", "all"].includes(state)) return json({ error: "state must be open|closed|all" }, 400);
      const out = []; let page = 1;
      while (page <= 10) {
        const r = await gh(env, `/repos/${env.REPO}/issues?state=${state}&labels=${LABELS.join(",")}&per_page=100&page=${page}`);
        if (!r.ok) return json({ error: "tracker read failed", status: r.status }, 502);
        const items = (await r.json()).filter(i => !i.pull_request);
        out.push(...items.map(issueView));
        if (items.length < 100) break; page++;
      }
      return json(out, 200, { "x-state-applied": state, "x-total-count": String(out.length) });
    }
    const one = p.match(/^\/feedback\/(\d+)$/);
    if (one && req.method === "GET") {
      const r = await gh(env, `/repos/${env.REPO}/issues/${one[1]}`);
      if (r.status === 404) return json({ error: "not found" }, 404);
      if (!r.ok) return json({ error: "tracker read failed", status: r.status }, 502);
      const i = await r.json();
      if (!(i.labels || []).some(l => l.name === LABELS[0])) return json({ error: "not a skill-feedback ticket" }, 404);
      const c = await gh(env, `/repos/${env.REPO}/issues/${one[1]}/comments?per_page=100`);
      const comments = c.ok ? (await c.json()).map(x => ({ author: x.user?.login, createdAt: x.created_at, body: x.body })) : [];
      return json({ ...issueView(i), body: i.body, comments });
    }
    if (p === "/feedback" && req.method === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "body must be JSON {title, body, reporter, kind?}" }, 400); }
      const { title, body, reporter, kind } = b || {};
      if (!title || !body || !reporter) return json({ error: "title, body and reporter are required" }, 400);
      if (String(title).length > CAPS.title) return json({ error: `title over ${CAPS.title} characters` }, 413);
      if (String(body).length > CAPS.body) return json({ error: `body over ${CAPS.body} characters` }, 413);
      const issueBody = `reporter: ${reporter}\nkind: ${kind || "report"}\nsource: ${env.SOURCE}\n\n${body}`;
      const r = await gh(env, `/repos/${env.REPO}/issues`, { method: "POST", body: JSON.stringify({ title: String(title), body: issueBody, labels: LABELS }) });
      if (!r.ok) return json({ error: "tracker write failed", status: r.status }, 502);
      const i = await r.json();
      return json({ number: i.number, url: i.html_url, covers: "this skill's documents, front and reference files" }, 201);
    }
    return json({ error: "not found", routes: ["GET /skill", "GET /DICTIONARY.md", "GET /ENABLEMENT.md", "GET /reference/*", "GET /feedback[?state=]", "GET /feedback/{n}", "POST /feedback"] }, 404);
  },
};
