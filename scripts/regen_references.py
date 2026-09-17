#!/usr/bin/env python3
"""Regenerate the two data-derived reference files from the live wire (GET only):
  reference/timeback-math-academy-courses.json  - every OneRoster course titled Math Academy (ids are the domain of the course field)
  reference/topic-course-map.json               - topic id -> majority Timeback COURSE ID from 14 days of lesson events
Run before every deploy that should refresh them; build_front.py pins their sha256 into the front."""
import base64, json, pathlib, re, collections, datetime, urllib.parse, urllib.request, os
ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = pathlib.Path(os.environ.get("TIMEBACK_ENV_FILE", r"C:\Users\baidr\OneDrive\Desktop\Timeback Reporting\Test Creation\Test Creation 2026 Julian\.env"))
vals = {}
for line in ENV.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1); vals[k.strip()] = v.strip().strip('"').strip("'")
tok_url = vals.get("ONEROSTER_TOKEN_URL") or "https://prod-beyond-timeback-api-2-idp.auth.us-east-1.amazoncognito.com/oauth2/token"
basic = base64.b64encode(f"{vals['AWS_COGNITO_APP_CLIENT_ID']}:{vals['AWS_COGNITO_CLIENT_SECRET']}".encode()).decode()
req = urllib.request.Request(tok_url, data=b"grant_type=client_credentials", headers={"Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + basic})
TOKEN = json.loads(urllib.request.urlopen(req, timeout=30).read())["access_token"]
B = "https://api.alpha-1edtech.ai"; TODAY = datetime.date.today()
def get(path, params=None):
    with urllib.request.urlopen(urllib.request.Request(B + path + ("?" + urllib.parse.urlencode(params) if params else ""), headers={"Authorization": "Bearer " + TOKEN}), timeout=180) as r: return json.loads(r.read())
def get_all(path, key, params):
    out, offset = [], 0
    while True:
        d = get(path, dict(params, limit=3000, offset=offset)); b = d.get(key) or []; out += b; offset += len(b)
        if not b or offset >= (d.get("totalCount") or 0): break
    return out

# ---- courses ------------------------------------------------------------------------------
cs = get("/ims/oneroster/rostering/v1p2/courses/", {"filter": "title~'Math Academy'", "limit": 100}).get("courses") or []
courses = [{"sourcedId": c["sourcedId"], "title": c.get("title"), "status": c.get("status"), "grades": c.get("grades"), "orgSourcedId": (c.get("org") or {}).get("sourcedId"),
            "primaryApp": (c.get("metadata") or {}).get("primaryApp"), "courseType": (c.get("metadata") or {}).get("courseType"),
            "metrics_totalXp": ((c.get("metadata") or {}).get("metrics") or {}).get("totalXp"), "metrics_totalLessons": ((c.get("metadata") or {}).get("metrics") or {}).get("totalLessons")}
           for c in sorted(cs, key=lambda c: c.get("title") or "")]
(ROOT / "reference" / "timeback-math-academy-courses.json").write_text(json.dumps({
    "_about": "OneRoster courses whose title contains 'Math Academy', read live by scripts/regen_references.py. This is the DOMAIN of the course field for Math Academy data in Timeback (structure). metrics_totalXp is the course's size in XP as the school sets it from Math Academy's XP-with-reviews table; it is a SNAPSHOT as of `readAt` and can lag an edit, so the XP-remaining estimate reads it live from the course object (DICTIONARY trap 11). Regenerate with the call below.",
    "readAt": TODAY.isoformat(), "regenerate": "GET https://api.alpha-1edtech.ai/ims/oneroster/rostering/v1p2/courses/?filter=title~'Math Academy'&limit=100", "courses": courses}, indent=1), encoding="utf-8")
print("courses:", len(courses))

# ---- topic -> course id map (lesson only; quiz and multistep URLs carry an instance/problem id in the topic slot, reviews revisit earlier courses) ----
since = (TODAY - datetime.timedelta(days=14)).isoformat()
res = get_all("/ims/oneroster/gradebook/v1p2/assessmentResults", "assessmentResults", {"filter": f"metadata.appName='Math Academy' AND scoreDate>='{since}'"})
li_course = {}
# line items: the course each event was FILED under (the truthful path); fetch per distinct line item via per-course listing to keep calls bounded
by_li = {r["assessmentLineItem"]["sourcedId"]: r for r in res}
course_ids = [c["sourcedId"] for c in courses]
for cid in course_ids:
    for li in get_all("/ims/oneroster/gradebook/v1p2/assessmentLineItems", "assessmentLineItems", {"filter": f"course.sourcedId='{cid}' AND dateLastModified>='{since}'"}):
        if li["sourcedId"] in by_li: li_course[li["sourcedId"]] = cid
# test users: exclude
sids = {r["student"]["sourcedId"] for r in res}
test = set()
for sid in sids:
    try:
        u = get(f"/ims/oneroster/rostering/v1p2/users/{sid}").get("user") or {}
        if (u.get("metadata") or {}).get("isTestUser"): test.add(sid)
    except Exception: pass
votes = collections.defaultdict(lambda: collections.defaultdict(set))
for r in res:
    if r["student"]["sourcedId"] in test: continue
    m = re.search(r"/topics/(\d+)/(lesson)$", (r.get("metadata") or {}).get("originalObjectId") or "")
    cid = li_course.get(r["assessmentLineItem"]["sourcedId"])
    if m and cid: votes[int(m.group(1))][cid].add(r["student"]["sourcedId"])
title_of = {c["sourcedId"]: c["title"] for c in courses}
topics = {}
dropped = 0
for t, per in votes.items():
    n = sum(len(s) for s in per.values()); top, s = max(per.items(), key=lambda kv: len(kv[1]))
    if n >= 5 and len(s) / n >= 0.8: topics[str(t)] = {"courseSourcedId": top, "courseTitle": title_of.get(top), "students": n, "share": round(len(s) / n, 2)}
    elif n >= 5: dropped += 1
(ROOT / "reference" / "topic-course-map.json").write_text(json.dumps({
    "_about": "Math Academy topic id -> the Timeback COURSE ID (sourcedId) under which lesson events for that topic were filed by >= 5 distinct non-test students with >= 80% agreement, over the 14 days before `readAt`. Filed course comes from each event's LINE ITEM (the truthful path, DICTIONARY trap 21). Reviews are excluded because they revisit earlier courses; quizzes and multisteps are excluded because their URL carries a quiz-instance / problem id in the topic slot, not a topic id (traps 25). Its range is Timeback's own course list: a Math Academy course with no Timeback course in your org (8th Grade Math in the main org) can never be pointed at. HEURISTIC: adjacent grade courses share topics, so this is the course most students who met the topic were filed under, not Math Academy's catalogue. Coverage is dense for grade-level courses and thin for high-school courses. Rebuild it yourself with ENABLEMENT example 7 step A; the measure of its bar is topics_dropped_by_share against topics_mapped, both in this file.",
    "readAt": TODAY.isoformat(), "window_days": 14, "min_students": 5, "min_share": 0.8, "topics_mapped": len(topics), "topics_with_enough_students_but_below_share": dropped,
    "topics": topics}, indent=0), encoding="utf-8")
print("results:", len(res), "| line items resolved:", len(li_course), "| test users excluded:", len(test), "| topics mapped:", len(topics), "| dropped by share:", dropped)
