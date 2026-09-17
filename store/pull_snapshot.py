#!/usr/bin/env python3
"""One snapshot of Math Academy's student records, matched to Timeback students. GET only, both sides.

  Math Academy : GET /api/beta10/students?page=N&pageSize=1000   (the bulk list; no email on it)
                 GET /api/beta10/students/{email}                 (fallback, one call per still-unmatched roster student)
  Timeback     : classes titled 'Math Academy*' -> enrollments (active, today inside beginDate..endDate)
                 -> /classes/{id}/students (email, names, SIS identifier, isTestUser, userProfiles[math_academy].username)

Match chain per Timeback roster student (recorded as matchedBy):
  1 'username'   the Math Academy login username on the student's Timeback userProfiles equals a bulk-list username
  2 'email'      the bulk-list username equals the Timeback email
  3 'lookup'     GET /students/{timeback email} answers 200 (one extra call)  -> matched by Math Academy id
  4 'name'       exactly one bulk-list record has the same first + last name (low confidence, flagged)
  else           tb_unmatched with the reason (404 = no Math Academy account under our key; 401 = under another organisation's key)

Writes ONE file (contains student names/emails; keep it out of git and out of anything served):
  <out> = _scratch/_snapshot_<UTC date>.json   {snapshotAt, apiVersion, calls, counts, students[], tb_unmatched[], ma_unmatched[]}

Usage:
  py -3 store/pull_snapshot.py --timeback-env <path to .env with AWS_COGNITO_APP_CLIENT_ID/AWS_COGNITO_CLIENT_SECRET>
                               (--ma-key-file <file holding the key> | --ma-key-env MA_API_KEY | --ma-key-notebook <ipynb>)
                               [--out <json>] [--no-lookup]
"""
import argparse, base64, datetime, json, os, pathlib, re, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument("--timeback-env", required=True)
ap.add_argument("--ma-key-file"); ap.add_argument("--ma-key-env", default="MA_API_KEY"); ap.add_argument("--ma-key-notebook")
ap.add_argument("--out"); ap.add_argument("--no-lookup", action="store_true"); ap.add_argument("--page-size", type=int, default=1000)
a = ap.parse_args()

NOW = datetime.datetime.now(datetime.timezone.utc)
TODAY = NOW.date()
OUT = pathlib.Path(a.out) if a.out else ROOT / "_scratch" / f"_snapshot_{TODAY.isoformat()}.json"
OUT.parent.mkdir(exist_ok=True)
LOG = OUT.with_suffix(".log")
def log(msg):
    line = f"{datetime.datetime.now().strftime('%H:%M:%S')} {msg}"; print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f: f.write(line + "\n")

# ---- credentials, runtime only, never printed --------------------------------------------------
vals = {}
for line in pathlib.Path(a.timeback_env).read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.strip().split("=", 1); vals[k.strip()] = v.strip().strip('"').strip("'")
MA_KEY = None
if a.ma_key_file: MA_KEY = pathlib.Path(a.ma_key_file).read_text(encoding="utf-8").strip()
elif os.environ.get(a.ma_key_env): MA_KEY = os.environ[a.ma_key_env].strip()
elif a.ma_key_notebook:
    nb = json.loads(pathlib.Path(a.ma_key_notebook).read_text(encoding="utf-8"))
    MA_KEY = next((re.search(r"Public-API-key'\s*:\s*'([^']+)'", "".join(c.get("source", []))).group(1)
                   for c in nb["cells"] if "Public-API-key" in "".join(c.get("source", []))), None)
if not MA_KEY: sys.exit("no Math Academy key given")
TOK_URL = vals.get("ONEROSTER_TOKEN_URL") or "https://prod-beyond-timeback-api-2-idp.auth.us-east-1.amazoncognito.com/oauth2/token"
BASIC = base64.b64encode(f"{vals['AWS_COGNITO_APP_CLIENT_ID']}:{vals['AWS_COGNITO_CLIENT_SECRET']}".encode()).decode()
TB = "https://api.alpha-1edtech.ai"; MA = "https://mathacademy.com/api/beta10"
TOKEN = None
def mint():
    global TOKEN
    req = urllib.request.Request(TOK_URL, data=b"grant_type=client_credentials",
                                 headers={"Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + BASIC})
    TOKEN = json.loads(urllib.request.urlopen(req, timeout=30).read())["access_token"]
mint()
calls = {"timeback": 0, "ma_bulk": 0, "ma_lookup": 0}

def tb(path, params=None, retry=4):
    url = TB + path + ("?" + urllib.parse.urlencode(params) if params else "")
    for i in range(retry + 1):
        try:
            calls["timeback"] += 1
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + TOKEN}), timeout=90) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 401 and i < retry: mint(); continue
            if e.code in (429, 500, 502, 503, 504) and i < retry: time.sleep(3 * (i + 1)); continue
            raise
        except (urllib.error.URLError, OSError):
            if i < retry: time.sleep(3 * (i + 1)); continue
            raise
def tb_all(path, key, params):
    items, offset = [], 0
    while True:
        d = tb(path, dict(params, limit=3000, offset=offset)); batch = d.get(key) or []
        items.extend(batch); offset += len(batch); total = d.get("totalCount")
        if not batch or (total is not None and offset >= total): break
    return items
def ma_get(path, kind):
    for i in range(6):
        try:
            calls[kind] += 1
            with urllib.request.urlopen(urllib.request.Request(MA + path, headers={"Public-API-Key": MA_KEY, "Accept": "application/json"}), timeout=120) as r:
                return json.loads(r.read().decode("utf-8")), None
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                wait = int(e.headers.get("Retry-After") or 5 * (i + 1)); log(f"   MA HTTP {e.code}, waiting {wait}s"); time.sleep(wait); continue
            return None, f"HTTP {e.code}"
        except (urllib.error.URLError, OSError):
            time.sleep(3 * (i + 1)); continue
    return None, "gave up"

# ---- 1. Math Academy bulk list --------------------------------------------------------------------
bulk, page = [], 1
while True:
    d, err = ma_get(f"/students?page={page}&pageSize={a.page_size}", "ma_bulk")
    if d is None: sys.exit(f"bulk page {page} failed: {err}")
    batch = d.get("students") or []; bulk.extend(batch)
    pg = d.get("pagination") or {}
    log(f"MA bulk page {page}: {len(batch)} students; pagination={json.dumps(pg)}")
    if len(batch) < a.page_size or (pg.get("totalPages") and page >= int(pg["totalPages"])): break
    page += 1
by_username = {}; by_id = {}; by_name = {}
for s_ in bulk:
    if s_.get("username"): by_username.setdefault(str(s_["username"]).lower(), s_)
    by_id[str(s_.get("id"))] = s_
    by_name.setdefault(f"{(s_.get('firstName') or '').strip().lower()} {(s_.get('lastName') or '').strip().lower()}", []).append(s_)
log(f"MA bulk total: {len(bulk)} students, {sum(1 for s_ in bulk if s_.get('deactivated'))} deactivated, {sum(1 for s_ in bulk if not s_.get('currentCourse'))} without a current course")

# ---- 2. Timeback roster -----------------------------------------------------------------------------
def in_window(e):
    b, en = e.get("beginDate"), e.get("endDate")
    try:
        if b and TODAY < datetime.date.fromisoformat(b[:10]): return False
        if en and TODAY > datetime.date.fromisoformat(en[:10]): return False
    except ValueError: pass
    return True
classes = [c for c in tb_all("/ims/oneroster/rostering/v1p2/classes/", "classes", {"filter": "title~'Math Academy'"})
           if (c.get("title") or "").lower().startswith("math academy")]
log(f"Timeback classes titled Math Academy*: {len(classes)}")
roster = {}
for c in classes:
    cid = c["sourcedId"]
    enr = tb_all("/ims/oneroster/rostering/v1p2/enrollments/", "enrollments", {"filter": f"class.sourcedId='{cid}' AND status='active'"})
    live = [e for e in enr if e.get("role") == "student" and in_window(e)]
    if not live: continue
    users = {u["sourcedId"]: u for u in tb_all(f"/ims/oneroster/rostering/v1p2/classes/{cid}/students", "users", {})}
    for e in live:
        uid = (e.get("user") or {}).get("sourcedId"); u = users.get(uid) or {}
        ma_user = next((cr.get("username") for p in (u.get("userProfiles") or []) if p.get("vendorId") == "math_academy"
                        for cr in (p.get("credentials") or []) if cr.get("username")), None)
        rec = roster.setdefault(uid, {"sourcedId": uid, "email": (u.get("email") or u.get("username") or "").lower(),
                                      "givenName": u.get("givenName") or "", "familyName": u.get("familyName") or "",
                                      "identifier": u.get("identifier"), "grades": u.get("grades") or [],
                                      "isTestUser": bool((u.get("metadata") or {}).get("isTestUser")),
                                      "org": (u.get("primaryOrg") or {}).get("name"), "maUsername": ma_user, "seats": []})
        rec["seats"].append({"classSourcedId": cid, "courseSourcedId": (e.get("course") or {}).get("sourcedId"),
                             "courseName": (e.get("course") or {}).get("name") or re.sub(r"\s+class$", "", c.get("title") or "", flags=re.I),
                             "beginDate": e.get("beginDate"), "endDate": e.get("endDate"), "primary": e.get("primary"),
                             "pctCompleteApp": (e.get("metadata") or {}).get("pctCompleteApp")})
log(f"Timeback roster: {len(roster)} students with a current Math Academy seat ({sum(1 for r in roster.values() if r['isTestUser'])} test users)")

# ---- 3. match ------------------------------------------------------------------------------------------
students, tb_unmatched, used_ma_ids = [], [], set()
def attach(rec, ma_rec, how):
    used_ma_ids.add(str(ma_rec.get("id")))
    students.append({**rec, "matchedBy": how, "mathAcademy": ma_rec})
todo_lookup = []
for rec in roster.values():
    m = by_username.get((rec["maUsername"] or "").lower()) if rec["maUsername"] else None
    if m: attach(rec, m, "username"); continue
    m = by_username.get(rec["email"]) if rec["email"] else None
    if m: attach(rec, m, "email"); continue
    todo_lookup.append(rec)
log(f"matched by username/email: {len(students)}; needing a per-student lookup: {len(todo_lookup)}")
for i, rec in enumerate(todo_lookup, 1):
    done = False
    if not a.no_lookup and rec["email"]:
        d, err = ma_get(f"/students/{urllib.parse.quote(rec['email'])}", "ma_lookup")
        if d is not None and (d.get("student") or {}):
            st = d["student"]; st = {**st, "id": st.get("id") or st.get("studentId")}
            attach(rec, st, "lookup"); done = True
        else:
            reason = err or "empty"
    else:
        reason = "no email" if not rec["email"] else "lookup disabled"
    if not done:
        cands = by_name.get(f"{rec['givenName'].strip().lower()} {rec['familyName'].strip().lower()}", [])
        if len(cands) == 1 and str(cands[0].get("id")) not in used_ma_ids:
            attach(rec, cands[0], "name"); done = True
    if not done:
        tb_unmatched.append({**rec, "reason": reason})
    if i % 50 == 0: log(f"   lookups {i}/{len(todo_lookup)}")
    time.sleep(0.15)
ma_unmatched = [s_ for s_ in bulk if str(s_.get("id")) not in used_ma_ids]

counts = {"maBulk": len(bulk), "timebackRoster": len(roster), "timebackTestUsers": sum(1 for r in roster.values() if r["isTestUser"]),
          "matched": len(students), "matchedBy": {k: sum(1 for s_ in students if s_["matchedBy"] == k) for k in ("username", "email", "lookup", "name")},
          "tbUnmatched": len(tb_unmatched), "tbUnmatchedByReason": {}, "maUnmatched": len(ma_unmatched),
          "maUnmatchedDeactivated": sum(1 for s_ in ma_unmatched if s_.get("deactivated")),
          "courseAgreement": {}}
for u in tb_unmatched: counts["tbUnmatchedByReason"][u["reason"]] = counts["tbUnmatchedByReason"].get(u["reason"], 0) + 1

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from agreement import agreement, summarise
for s_ in students:
    s_["courseAgreementAtSnapshot"] = agreement(s_["mathAcademy"], [seat["courseName"] for seat in s_["seats"]])
counts["courseAgreement"], by_course = summarise(students, tb_unmatched)

snap = {"snapshotAt": NOW.isoformat(timespec="seconds"), "rosterReadAt": NOW.isoformat(timespec="seconds"), "apiVersion": "beta10", "calls": calls, "counts": counts, "byCourse": by_course,
        "students": students, "tb_unmatched": tb_unmatched, "ma_unmatched": ma_unmatched}
OUT.write_text(json.dumps(snap, indent=0, ensure_ascii=False), encoding="utf-8")
log(f"calls: {json.dumps(calls)}")
log(f"counts: {json.dumps(counts)}")
log(f"wrote {OUT}")
