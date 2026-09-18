"""The Math Academy store: pull, match, write. One library used by the nightly Lambda (lambda/nightly/handler.py)
and by the local CLI (store/pull_snapshot.py). GET only against Timeback and Math Academy; writes only to this
skill's own DynamoDB table.

Table mathacademy-timeback-skill-store (pk S / sk S):
  student      / <tb sid>        ma(JSON) maId matchedBy courseAgreementAtSnapshot seats(JSON) isTestUser snapshotAt figuresAsOf
  tb_unmatched / <tb sid>        reason seats(JSON) isTestUser snapshotAt
  ma_unmatched / <ma id>         ma(JSON) snapshotAt                      (counted, never served row by row)
  meta         / snapshot        snapshotAt rosterReadAt apiVersion calls counts byCourse history staleAfterDays nightly
  hist#<sid>   / <YYYY-MM-DD>    compact nightly record of the Math Academy course figures (course history, kept forever)
  act#<sid>    / <date>#<taskId> one Math Academy task with its analysis (engaged / productive time)
  actday#<sid> / <date>          the day's totals from Math Academy
  actrun       / <date>          progress of the activity pull for that date (resume cursor)
  know#<sid>   / latest          the cached knowledge map (fetched on demand by the front)
"""
import base64, datetime, json, re, time, urllib.error, urllib.parse, urllib.request
from zoneinfo import ZoneInfo
CHICAGO = ZoneInfo("America/Chicago")

try:
    from .agreement import agreement, summarise, ma_state, ma_courses
except ImportError:  # flat import when zipped into a Lambda
    from agreement import agreement, summarise, ma_state, ma_courses

TB = "https://api.alpha-1edtech.ai"
MA = "https://mathacademy.com/api/beta10"
TOK_URL_DEFAULT = "https://prod-beyond-timeback-api-2-idp.auth.us-east-1.amazoncognito.com/oauth2/token"
UTC = datetime.timezone.utc


class Clients:
    """Timeback (client credentials) + Math Academy (public API key). Values live only in memory."""
    def __init__(self, creds, log=print):
        self.tok_url = creds.get("ONEROSTER_TOKEN_URL") or TOK_URL_DEFAULT
        self.basic = base64.b64encode(f"{creds['AWS_COGNITO_APP_CLIENT_ID']}:{creds['AWS_COGNITO_CLIENT_SECRET']}".encode()).decode()
        self.ma_key = creds["MA_API_KEY"]
        self.token = None; self.log = log
        self.calls = {"timeback": 0, "ma_bulk": 0, "ma_lookup": 0, "ma_activity": 0, "ma_knowledge": 0}
        self.mint()

    def mint(self):
        req = urllib.request.Request(self.tok_url, data=b"grant_type=client_credentials",
                                     headers={"Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + self.basic})
        self.token = json.loads(urllib.request.urlopen(req, timeout=30).read())["access_token"]

    def tb(self, path, params=None, retry=4):
        url = TB + path + ("?" + urllib.parse.urlencode(params) if params else "")
        for i in range(retry + 1):
            try:
                self.calls["timeback"] += 1
                with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + self.token}), timeout=90) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code == 401 and i < retry: self.mint(); continue
                if e.code in (429, 500, 502, 503, 504) and i < retry: time.sleep(3 * (i + 1)); continue
                raise
            except (urllib.error.URLError, OSError):
                if i < retry: time.sleep(3 * (i + 1)); continue
                raise

    def tb_all(self, path, key, params):
        items, offset = [], 0
        while True:
            d = self.tb(path, dict(params, limit=3000, offset=offset)); batch = d.get(key) or []
            items.extend(batch); offset += len(batch); total = d.get("totalCount")
            if not batch or (total is not None and offset >= total): break
        return items

    def ma(self, path, kind):
        """-> (json, None) or (None, 'HTTP 404' | 'HTTP 401' | 'gave up')"""
        for i in range(6):
            try:
                self.calls[kind] += 1
                with urllib.request.urlopen(urllib.request.Request(MA + path, headers={"Public-API-Key": self.ma_key, "Accept": "application/json"}), timeout=120) as r:
                    return json.loads(r.read().decode("utf-8")), None
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    wait = int(e.headers.get("Retry-After") or 5 * (i + 1)); self.log(f"MA HTTP {e.code}, waiting {wait}s"); time.sleep(min(wait, 60)); continue
                return None, f"HTTP {e.code}"
            except (urllib.error.URLError, OSError):
                time.sleep(3 * (i + 1)); continue
        return None, "gave up"


# ---- pulls -----------------------------------------------------------------------------------------------
def pull_bulk(c, page_size=1000):
    bulk, page = [], 1
    while True:
        d, err = c.ma(f"/students?page={page}&pageSize={page_size}", "ma_bulk")
        if d is None: raise RuntimeError(f"bulk page {page} failed: {err}")
        batch = d.get("students") or []; bulk.extend(batch); pg = d.get("pagination") or {}
        c.log(f"MA bulk page {page}: {len(batch)}")
        if len(batch) < page_size or (pg.get("totalPages") and page >= int(pg["totalPages"])): break
        page += 1
    return bulk


def in_window(e, today):
    b, en = e.get("beginDate"), e.get("endDate")
    try:
        if b and today < datetime.date.fromisoformat(b[:10]): return False
        if en and today > datetime.date.fromisoformat(en[:10]): return False
    except ValueError: pass
    return True


TEST_NAME = re.compile(r"\b(shadow|test|demo|e2e|guide sixth grade|mock|placeholder|sample)\b", re.I)
TEST_ORG = re.compile(r"(100for100|guide school|mock|lwai|e2e|sandbox)", re.I)
def likely_test(u, is_flagged):
    """isTestUser OR a synthetic naming pattern OR a test campus, judged here so no reader has to look at names."""
    name = f"{u.get('givenName') or ''} {u.get('familyName') or ''}"; org = (u.get("primaryOrg") or {}).get("name") or ""
    return bool(is_flagged or TEST_NAME.search(name) or TEST_ORG.search(org) or re.search(r"\b(grade|g)\s*\d+\s*shadow", name, re.I))

def pull_roster(c, today):
    """Every student with a current in-window active enrollment in a class titled 'Math Academy…'."""
    courses = [x for x in c.tb_all("/ims/oneroster/rostering/v1p2/courses/", "courses", {"filter": "title~'Math Academy'"})
               if (x.get("title") or "").lower().startswith("math academy")]
    classes, seen = [], set()
    for co in courses:  # every section of every Math Academy course, whatever the section is titled (DICTIONARY trap 1)
        for x in c.tb_all("/ims/oneroster/rostering/v1p2/classes/", "classes", {"filter": f"course.sourcedId='{co['sourcedId']}'"}):
            if x["sourcedId"] not in seen: seen.add(x["sourcedId"]); classes.append(x)
    c.log(f"Timeback Math Academy courses: {len(courses)}; sections: {len(classes)}")
    roster = {}
    for cl in classes:
        cid = cl["sourcedId"]
        enr = c.tb_all("/ims/oneroster/rostering/v1p2/enrollments/", "enrollments", {"filter": f"class.sourcedId='{cid}' AND status='active'"})
        live = [e for e in enr if e.get("role") == "student" and in_window(e, today)]
        if not live: continue
        users = {u["sourcedId"]: u for u in c.tb_all(f"/ims/oneroster/rostering/v1p2/classes/{cid}/students", "users", {})}
        for e in live:
            uid = (e.get("user") or {}).get("sourcedId"); u = users.get(uid) or {}
            ma_user = next((cr.get("username") for p in (u.get("userProfiles") or []) if p.get("vendorId") == "math_academy"
                            for cr in (p.get("credentials") or []) if cr.get("username")), None)
            rec = roster.setdefault(uid, {"sourcedId": uid, "email": (u.get("email") or u.get("username") or "").lower(),
                                          "givenName": u.get("givenName") or "", "familyName": u.get("familyName") or "",
                                          "identifier": u.get("identifier"), "grades": u.get("grades") or [],
                                          "isTestUser": bool((u.get("metadata") or {}).get("isTestUser")),
                                          "isLikelyTest": likely_test(u, bool((u.get("metadata") or {}).get("isTestUser"))),
                                          "org": (u.get("primaryOrg") or {}).get("name"), "maUsername": ma_user, "seats": []})
            rec["seats"].append({"classSourcedId": cid, "courseSourcedId": (e.get("course") or {}).get("sourcedId"),
                                 "courseName": (e.get("course") or {}).get("name") or re.sub(r"\s+class$", "", cl.get("title") or "", flags=re.I),
                                 "beginDate": e.get("beginDate"), "endDate": e.get("endDate"), "primary": e.get("primary"),
                                 "pctCompleteApp": (e.get("metadata") or {}).get("pctCompleteApp")})
    c.log(f"Timeback roster: {len(roster)} students")
    return roster


# ---- match ----------------------------------------------------------------------------------------------------
def match(c, bulk, roster, known_ids=None, time_left=lambda: 10 ** 9, lookup=True, log=print):
    """known_ids: {tb sid: ma id} from the previous snapshot (step 0, no call). Returns (students, tb_unmatched)."""
    known_ids = known_ids or {}
    by_username, by_id, by_name = {}, {}, {}
    for s_ in bulk:
        if s_.get("username"): by_username.setdefault(str(s_["username"]).lower(), s_)
        by_id[str(s_.get("id"))] = s_
        by_name.setdefault(f"{(s_.get('firstName') or '').strip().lower()} {(s_.get('lastName') or '').strip().lower()}", []).append(s_)
    students, tb_unmatched, used = [], [], set()
    def attach(rec, ma_rec, how):
        used.add(str(ma_rec.get("id"))); students.append({**rec, "matchedBy": how, "mathAcademy": ma_rec})
    todo = []
    for rec in roster.values():
        k = known_ids.get(rec["sourcedId"])
        if k and str(k) in by_id: attach(rec, by_id[str(k)], "known"); continue
        m = by_username.get((rec["maUsername"] or "").lower()) if rec["maUsername"] else None
        if m: attach(rec, m, "username"); continue
        m = by_username.get(rec["email"]) if rec["email"] else None
        if m: attach(rec, m, "email"); continue
        todo.append(rec)
    log(f"matched without a call: {len(students)}; needing a lookup: {len(todo)}")
    for i, rec in enumerate(todo, 1):
        done, reason = False, None
        if not lookup: reason = "lookup disabled"
        elif time_left() < 90: reason = "deferred: out of time tonight"
        elif not rec["email"]: reason = "no email"
        else:
            d, err = c.ma(f"/students/{urllib.parse.quote(rec['email'])}", "ma_lookup")
            if d is not None and (d.get("student") or {}):
                st = d["student"]; st = {**st, "id": st.get("id") or st.get("studentId")}
                attach(rec, st, "lookup"); done = True
            else:
                reason = err or "empty"
            time.sleep(0.15)
        if not done and reason not in ("deferred: out of time tonight",):
            cands = by_name.get(f"{rec['givenName'].strip().lower()} {rec['familyName'].strip().lower()}", [])
            if len(cands) == 1 and str(cands[0].get("id")) not in used: attach(rec, cands[0], "name"); done = True
        if not done: tb_unmatched.append({**rec, "reason": reason})
        if i % 100 == 0: log(f"lookups {i}/{len(todo)}")
    for s_ in students:
        s_["courseAgreementAtSnapshot"] = agreement(s_["mathAcademy"], [x["courseName"] for x in s_["seats"]])
    ma_unmatched = [s_ for s_ in bulk if str(s_.get("id")) not in used]
    return students, tb_unmatched, ma_unmatched


def counts_for(bulk, roster, students, tb_unmatched, ma_unmatched):
    overall, by_course = summarise(students, tb_unmatched)
    return {"maBulk": len(bulk), "timebackRoster": len(roster), "timebackTestUsers": sum(1 for r in roster.values() if r["isTestUser"]),
            "timebackLikelyTest": sum(1 for r in roster.values() if r.get("isLikelyTest")),
            "matched": len(students), "matchedBy": {k: sum(1 for s_ in students if s_["matchedBy"] == k) for k in ("known", "username", "email", "lookup", "name", "live-lookup", "activity-lookup", "backfill-lookup")},
            "maMatchedToMoreThanOneTimebackStudent": len(students) - len({str(s_["mathAcademy"].get("id")) for s_ in students}),
            "studentsWithTwoOrMoreSeats": sum(1 for r in roster.values() if len({s_["courseSourcedId"] for s_ in r["seats"]}) > 1),
            "sumsNote": "maBulk = matched distinct Math Academy ids + maUnmatched (+ maMatchedToMoreThanOneTimebackStudent when one record matched two Timeback students); byCourse counts SEATS, so its students sum to timebackRoster + the extra seats of studentsWithTwoOrMoreSeats",
            "tbUnmatched": len(tb_unmatched), "tbUnmatchedByReason": {r: sum(1 for u in tb_unmatched if u["reason"] == r) for r in sorted({u["reason"] for u in tb_unmatched})},
            "maUnmatched": len(ma_unmatched), "maUnmatchedDeactivated": sum(1 for s_ in ma_unmatched if s_.get("deactivated")),
            "maNotStarted": sum(1 for s_ in students if ma_state(s_["mathAcademy"].get("currentCourse")) == "not started"),
            "nonTest": {"basis": "isLikelyTest false: not flagged isTestUser AND no synthetic naming pattern AND not a test campus",
                        "students": sum(1 for r in roster.values() if not r.get("isLikelyTest")),
                        "maNotStarted": sum(1 for s_ in students if not s_.get("isLikelyTest") and ma_state(s_["mathAcademy"].get("currentCourse")) == "not started"),
                        "byAgreement": {**{k: sum(1 for s_ in students if not s_.get("isLikelyTest") and s_["courseAgreementAtSnapshot"] == k) for k in sorted({s_["courseAgreementAtSnapshot"] for s_ in students})},
                                        "no math academy record": sum(1 for u in tb_unmatched if not u.get("isLikelyTest"))},
                        "byMathAcademyState": {**{k: sum(1 for s_ in students if not s_.get("isLikelyTest") and ma_state(s_["mathAcademy"].get("currentCourse")) == k) for k in ("not started", "in progress", "at 100, not marked complete", "completed")},
                                               "no math academy record": sum(1 for u in tb_unmatched if not u.get("isLikelyTest"))}},
            "courseAgreement": overall}, by_course


# ---- DynamoDB ------------------------------------------------------------------------------------------------------
S = lambda v: {"S": str(v)}
def _batch(ddb, table, reqs):
    for i in range(0, len(reqs), 25):
        chunk = reqs[i:i + 25]
        for _ in range(10):
            r = ddb.batch_write_item(RequestItems={table: chunk}); chunk = (r.get("UnprocessedItems") or {}).get(table) or []
            if not chunk: break
            time.sleep(1)

def _query_all(ddb, table, pk, projection=None, **kw):
    out, key = [], None
    while True:
        args = {"TableName": table, "KeyConditionExpression": "pk = :p", "ExpressionAttributeValues": {":p": S(pk)}}
        if projection: args["ProjectionExpression"] = projection
        args.update(kw)
        if key: args["ExclusiveStartKey"] = key
        r = ddb.query(**args); out.extend(r["Items"]); key = r.get("LastEvaluatedKey")
        if not key: return out

def known_ids_from_table(ddb, table):
    return {it["sk"]["S"]: it["maId"]["S"] for it in _query_all(ddb, table, "student", "sk, maId") if "maId" in it}

def hist_row(st, date):
    cc = (st["mathAcademy"].get("currentCourse") or {})
    row = {"pk": S(f"hist#{st['sourcedId']}"), "sk": S(date), "courseId": S(cc.get("id")), "courseName": S(cc.get("name")),
            "xpRemaining": {"N": str(cc.get("xpRemaining") or 0)},
            "completed": S(cc.get("completed") or ""), "startDate": S(cc.get("startDate") or ""), "grade": {"N": str(cc.get("grade") or 0)},
            "letterGrade": S(cc.get("letterGrade") or ""), "estimatedScore": {"N": str(cc.get("estimatedScore") or 0)},
            "deactivated": {"BOOL": bool(st["mathAcademy"].get("deactivated"))}, "state": S(ma_state(cc)),
            "agreement": S(st["courseAgreementAtSnapshot"]), "tbCourseIds": S(json.dumps([x["courseSourcedId"] for x in st["seats"]]))}
    if cc.get("progress") is not None: row["progress"] = {"N": str(cc["progress"])}
    return row

def write_snapshot(ddb, table, snap, nightly=True, source="manual"):
    """Replace the student / tb_unmatched / ma_unmatched rows, append hist rows for the day, rewrite meta. Returns counts."""
    at = snap["snapshotAt"]; day = at[:10]
    old = []
    for pk in ("student", "tb_unmatched", "ma_unmatched"): old.extend(_query_all(ddb, table, pk, "pk, sk, backfilledAt, backfilledFrom, maId, matchedBy, ma, isTestUser, isLikelyTest, snapshotAt, figuresAsOf, offRosterSince"))
    # per-student attributes written by the backfill and the front between loads survive a load (a load replaces the Math Academy figures, not the activity coverage)
    keep = {it["sk"]["S"]: {k: it[k] for k in ("backfilledAt", "backfilledFrom") if k in it} for it in old if it["pk"]["S"] == "student"}
    _batch(ddb, table, [{"DeleteRequest": {"Key": {"pk": it["pk"], "sk": it["sk"]}}} for it in old])
    items = []
    # students who left the roster keep a row: last-known Math Academy record, no seats, so history/activity stay readable and the batch never re-pulls them
    roster = {st["sourcedId"] for st in snap["students"]}
    for it in old:
        if it["pk"]["S"] != "student" or it["sk"]["S"] in roster or "maId" not in it: continue
        row = {k: it[k] for k in ("backfilledAt", "backfilledFrom", "maId", "matchedBy", "ma", "isTestUser", "isLikelyTest", "snapshotAt", "figuresAsOf") if k in it}
        row.update({"pk": S("student"), "sk": it["sk"], "seats": S("[]"), "courseAgreementAtSnapshot": S("no current timeback seat"), "offRosterSince": it.get("offRosterSince") or S(at)})
        items.append({"PutRequest": {"Item": row}})
    for st in snap["students"]:
        items.append({"PutRequest": {"Item": {**keep.get(st["sourcedId"], {}), "pk": S("student"), "sk": S(st["sourcedId"]), "ma": S(json.dumps(st["mathAcademy"], ensure_ascii=False)),
                                              "maId": S(st["mathAcademy"].get("id")), "matchedBy": S(st["matchedBy"]), "courseAgreementAtSnapshot": S(st["courseAgreementAtSnapshot"]),
                                              "seats": S(json.dumps(st["seats"])), "isTestUser": {"BOOL": bool(st["isTestUser"])}, "isLikelyTest": {"BOOL": bool(st.get("isLikelyTest", st["isTestUser"]))}, "snapshotAt": S(at),
                                              "figuresAsOf": S(at), "grades": S(json.dumps(st.get("grades") or []))}}})
        items.append({"PutRequest": {"Item": hist_row(st, day)}})
    for u in snap["tb_unmatched"]:
        items.append({"PutRequest": {"Item": {"pk": S("tb_unmatched"), "sk": S(u["sourcedId"]), "reason": S(u["reason"]), "seats": S(json.dumps(u["seats"])),
                                              "isTestUser": {"BOOL": bool(u["isTestUser"])}, "isLikelyTest": {"BOOL": bool(u.get("isLikelyTest", u["isTestUser"]))}, "snapshotAt": S(at), "lastTriedAt": S(at), "email": S(u.get("email") or "")}}})
    for m in snap["ma_unmatched"]:
        items.append({"PutRequest": {"Item": {"pk": S("ma_unmatched"), "sk": S(m.get("id")), "ma": S(json.dumps(m, ensure_ascii=False)), "snapshotAt": S(at)}}})
    _batch(ddb, table, items)
    prev = ddb.get_item(TableName=table, Key={"pk": S("meta"), "sk": S("snapshot")}).get("Item")
    history = json.loads(prev["history"]["S"]) if prev and "history" in prev else []
    history = [h if isinstance(h, dict) else {"at": h, "source": "manual"} for h in history]
    if not any(h["at"] == at for h in history): history.append({"at": at, "source": source, "matched": len(snap["students"]), "roster": snap["counts"]["timebackRoster"]})
    meta = {"pk": S("meta"), "sk": S("snapshot"), "snapshotAt": S(at), "rosterReadAt": S(snap.get("rosterReadAt") or at), "apiVersion": S(snap["apiVersion"]),
            "calls": S(json.dumps(snap["calls"])), "counts": S(json.dumps(snap["counts"])), "byCourse": S(json.dumps(snap.get("byCourse") or {})),
            "history": S(json.dumps(history[-400:])), "staleAfterDays": {"N": "7" if not nightly else "2"}, "nightly": {"BOOL": bool(nightly)},
            "maCourses": S(json.dumps(ma_courses(snap["students"], snap["ma_unmatched"])))}
    for k in ("activityLastDate", "lastActivityRun", "readMaLookup", "readMaKnowledge", "readMaActivityBackfill", "readMaActivityBackfillStudents", "backfill"):
        if prev and k in prev: meta[k] = prev[k]
    ddb.put_item(TableName=table, Item=meta)
    return {"removed": len(old), "written": len(items)}


def run_snapshot(c, ddb, table, today=None, time_left=lambda: 10 ** 9, lookup=True, nightly=True, source="manual"):
    """The whole nightly: bulk -> roster -> match (known ids first) -> write. Returns the counts."""
    now = datetime.datetime.now(UTC); today = today or now.date()
    bulk = pull_bulk(c)
    roster = pull_roster(c, today)
    known = known_ids_from_table(ddb, table)
    students, tb_un, ma_un = match(c, bulk, roster, known_ids=known, time_left=time_left, lookup=lookup, log=c.log)
    counts, by_course = counts_for(bulk, roster, students, tb_un, ma_un)
    snap = {"snapshotAt": now.isoformat(timespec="seconds"), "rosterReadAt": now.isoformat(timespec="seconds"), "apiVersion": "beta10",
            "calls": c.calls, "counts": counts, "byCourse": by_course, "students": students, "tb_unmatched": tb_un, "ma_unmatched": ma_un}
    w = write_snapshot(ddb, table, snap, nightly=nightly, source=source)
    c.log(f"snapshot written: {w} counts: {json.dumps(counts)}")
    return snap


# ---- activity (engaged / productive time) -----------------------------------------------------------------------------
def local_day_window(day):
    """The America/Chicago calendar day as two UTC instants (DST-aware)."""
    d = datetime.date.fromisoformat(day)
    start = datetime.datetime(d.year, d.month, d.day, tzinfo=CHICAGO).astimezone(UTC)
    end = (datetime.datetime(d.year, d.month, d.day, tzinfo=CHICAGO) + datetime.timedelta(days=1)).astimezone(UTC)
    return start, end

def active_sids_for_day(c, day, tz_offset_hours=None):
    """Students with a Math Academy result on that local day (one paged estate-wide read)."""
    start, end = local_day_window(day); end = end - datetime.timedelta(seconds=1)
    f = f"metadata.appName='Math Academy' AND scoreDate>='{start.strftime('%Y-%m-%dT%H:%M:%SZ')}' AND scoreDate<='{end.strftime('%Y-%m-%dT%H:%M:%SZ')}'"
    rows = c.tb_all("/ims/oneroster/gradebook/v1p2/assessmentResults", "assessmentResults", {"filter": f})
    return sorted({(r.get("student") or {}).get("sourcedId") for r in rows if (r.get("student") or {}).get("sourcedId")})

def task_item(sid, day, t):
    an = t.get("analysis") or {}
    return {"pk": S(f"act#{sid}"), "sk": S(f"{day}#{t.get('id')}"), "taskId": S(t.get("id")), "type": S(t.get("type")),
            "xp": {"N": str(t.get("xp") or 0)}, "xpAwarded": {"N": str(t.get("xpAwarded") or 0)},
            "questions": {"N": str(t.get("questions") or 0)}, "questionsCorrect": {"N": str(t.get("questionsCorrect") or 0)},
            "startedEpochMs": {"N": str(t.get("started") or 0)}, "completedEpochMs": {"N": str(t.get("completed") or 0)},
            "courseId": S((t.get("course") or {}).get("id")), "courseName": S((t.get("course") or {}).get("name")),
            "topicId": S((t.get("topic") or {}).get("id")), "topicName": S((t.get("topic") or {}).get("name")),
            "timeElapsedMs": {"N": str(an.get("timeElapsed") or 0)}, "timeEngagedMs": {"N": str(an.get("timeEngaged") or 0)}, "timeProductiveMs": {"N": str(an.get("timeProductive") or 0)}}

def _delete_day(ddb, table, sid, day):
    rows = _query_all(ddb, table, f"act#{sid}", "pk, sk", **{"KeyConditionExpression": "pk = :p AND begins_with(sk, :d)", "ExpressionAttributeValues": {":p": S(f"act#{sid}"), ":d": S(day + "#")}})
    reqs = [{"DeleteRequest": {"Key": {"pk": r["pk"], "sk": r["sk"]}}} for r in rows]
    reqs.append({"DeleteRequest": {"Key": {"pk": S(f"actday#{sid}"), "sk": S(day)}}})
    _batch(ddb, table, reqs)

def run_activity(c, ddb, table, day, tz_offset_hours=None, time_left=lambda: 10 ** 9, force=False):
    """Pull Math Academy's per-task analysis for every student active on the local `day` (America/Chicago by offset).
    Math Academy's startDate/endDate are read on its own clock, so two Math Academy days are requested and tasks are kept by
    their completion time inside the local day window. Resumable: progress in actrun/<day>. force=True re-pulls a finished day."""
    run = ddb.get_item(TableName=table, Key={"pk": S("actrun"), "sk": S(day)}).get("Item")
    if run and run.get("status", {}).get("S") == "done" and not force: return {"day": day, "status": "done", "skipped": True}
    day_start, day_end = local_day_window(day)   # America/Chicago, DST-aware
    lo_ms, hi_ms = int(day_start.timestamp() * 1000), int(day_end.timestamp() * 1000)
    next_day = (datetime.date.fromisoformat(day) + datetime.timedelta(days=1)).isoformat()
    if run and not force and run.get("status", {}).get("S") in ("partial", "running"):
        pending = json.loads(run["pending"]["S"]); total = int(run["total"]["N"]); done = int(run["done"]["N"]); no_id = int(run["noMaId"]["N"]); errors = int(run.get("errors", {}).get("N", 0))
    else:
        sids = active_sids_for_day(c, day, tz_offset_hours)
        ids = {it["sk"]["S"]: it["maId"]["S"] for it in _query_all(ddb, table, "student", "sk, maId") if "maId" in it}
        missing = [s_ for s_ in sids if s_ not in ids]
        tried = {it["sk"]["S"] for it in _query_all(ddb, table, "tb_unmatched", "sk")}
        found = 0
        for s_ in missing:  # active students with no stored id: seatless (trap 21) or new; one Timeback read + one Math Academy lookup each, once
            if s_ in tried or time_left() < 120: continue
            try: u = c.tb(f"/ims/oneroster/rostering/v1p2/users/{s_}").get("user") or {}
            except Exception: continue
            email = (u.get("email") or u.get("username") or "").lower(); now = datetime.datetime.now(UTC).isoformat(timespec="seconds")
            d, err = c.ma(f"/students/{urllib.parse.quote(email)}", "ma_lookup") if email else (None, "no email")
            if d is not None and (d.get("student") or {}):
                st = d["student"]; st = {**st, "id": st.get("id") or st.get("studentId")}
                ddb.put_item(TableName=table, Item={"pk": S("student"), "sk": S(s_), "ma": S(json.dumps(st, ensure_ascii=False)), "maId": S(st["id"]), "matchedBy": S("activity-lookup"),
                                                    "courseAgreementAtSnapshot": S(agreement(st, [])), "seats": S("[]"), "isTestUser": {"BOOL": bool((u.get("metadata") or {}).get("isTestUser"))},
                                                    "snapshotAt": S(now), "figuresAsOf": S(now)})
                ids[s_] = str(st["id"]); found += 1
            else:
                ddb.put_item(TableName=table, Item={"pk": S("tb_unmatched"), "sk": S(s_), "reason": S(err or "empty"), "seats": S("[]"), "isTestUser": {"BOOL": bool((u.get("metadata") or {}).get("isTestUser"))},
                                                    "snapshotAt": S(now), "lastTriedAt": S(now), "email": S(email)})
            time.sleep(0.15)
        pending = [[s_, ids[s_]] for s_ in sids if s_ in ids]; no_id = len(sids) - len(pending); total = len(pending); done = 0; errors = 0
        for s_ in sids:
            if s_ not in ids:  # leave a per-day reason on the row a reader will hit
                ddb.put_item(TableName=table, Item={"pk": S(f"actday#{s_}"), "sk": S(day), "error": S("no Math Academy id for this student (not on the roster; the lookup by Timeback email found no account under this organisation's key)"),
                                                    "fetchedAt": S(datetime.datetime.now(UTC).isoformat(timespec="seconds"))})
        c.log(f"activity {day}: {len(sids)} active students, {len(missing)} without a stored id ({found} found by lookup), {total} to pull, window {day_start.isoformat()}..{day_end.isoformat()}")
    def save(status):
        ddb.put_item(TableName=table, Item={"pk": S("actrun"), "sk": S(day), "status": S(status), "total": {"N": str(total)}, "done": {"N": str(done)}, "errors": {"N": str(errors)},
                                            "noMaId": {"N": str(no_id)}, "pending": S(json.dumps(pending)), "windowUtc": S(f"{day_start.isoformat()}/{day_end.isoformat()}"),
                                            "updatedAt": S(datetime.datetime.now(UTC).isoformat(timespec="seconds"))})
    items = []
    while pending:
        if time_left() < 90: _batch(ddb, table, items); save("partial"); return {"day": day, "status": "partial", "done": done, "total": total}
        sid, ma_id = pending[0]
        if force: _delete_day(ddb, table, sid, day)
        d, err = c.ma(f"/students/{ma_id}/activity?startDate={day}&endDate={next_day}", "ma_activity")
        now = datetime.datetime.now(UTC).isoformat(timespec="seconds")
        if d is not None:
            tasks = [t for t in ((d.get("activity") or {}).get("tasks") or []) if lo_ms <= int(t.get("completed") or 0) < hi_ms]
            for t in tasks: items.append({"PutRequest": {"Item": task_item(sid, day, t)}})
            an = lambda k: sum(int((t.get("analysis") or {}).get(k) or 0) for t in tasks)
            items.append({"PutRequest": {"Item": {"pk": S(f"actday#{sid}"), "sk": S(day), "numTasks": {"N": str(len(tasks))},
                                                  "timeElapsedMs": {"N": str(an("timeElapsed"))}, "timeEngagedMs": {"N": str(an("timeEngaged"))}, "timeProductiveMs": {"N": str(an("timeProductive"))},
                                                  "xpAwarded": {"N": str(sum(int(t.get("xpAwarded") or 0) for t in tasks))},
                                                  "questions": {"N": str(sum(int(t.get("questions") or 0) for t in tasks))}, "questionsCorrect": {"N": str(sum(int(t.get("questionsCorrect") or 0) for t in tasks))},
                                                  "windowUtc": S(f"{day_start.isoformat()}/{day_end.isoformat()}"), "fetchedAt": S(now)}}})
        else:
            errors += 1
            items.append({"PutRequest": {"Item": {"pk": S(f"actday#{sid}"), "sk": S(day), "error": S(err), "fetchedAt": S(now)}}})
        pending.pop(0); done += 1
        if len(items) >= 200: _batch(ddb, table, items); items = []; save("running")
        time.sleep(0.15)
    _batch(ddb, table, items); save("done")
    finished = datetime.datetime.now(UTC).isoformat(timespec="seconds")
    prev = (ddb.get_item(TableName=table, Key={"pk": S("meta"), "sk": S("snapshot")}).get("Item") or {}).get("activityLastDate", {}).get("S") or ""
    ddb.update_item(TableName=table, Key={"pk": S("meta"), "sk": S("snapshot")}, UpdateExpression="SET activityLastDate = :d, lastActivityRun = :r",
                    ExpressionAttributeValues={":d": S(max(day, prev)), ":r": S(json.dumps({"day": day, "students": total, "done": done, "errors": errors, "noMaId": no_id, "finishedAt": finished, "maCalls": c.calls["ma_activity"], "windowUtc": f"{day_start.isoformat()}/{day_end.isoformat()}", "rePull": bool(force)}))})
    c.log(f"activity {day}: done {done}/{total}, errors {errors}, calls {c.calls}")
    return {"day": day, "status": "done", "done": done, "total": total, "errors": errors, "noMaId": no_id}


# ---- one-off backfill: per student, by date range ------------------------------------------------------------------------------
def _quarters(start, end):
    out, a = [], start
    while a <= end:
        b = min(a + datetime.timedelta(days=91), end)
        out.append((a.isoformat(), b.isoformat())); a = b + datetime.timedelta(days=1)
    return out

def _chicago_day(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, tz=UTC).astimezone(CHICAGO).date().isoformat()

def backfill_students_without_rows(c, ddb, table, time_left=lambda: 10 ** 9):
    """Students who ever held a Math Academy seat in Timeback (any status) but have no store row: look each up once by email."""
    have = {it["sk"]["S"] for it in _query_all(ddb, table, "student", "sk")} | {it["sk"]["S"] for it in _query_all(ddb, table, "tb_unmatched", "sk")}
    courses = [x for x in c.tb_all("/ims/oneroster/rostering/v1p2/courses/", "courses", {"filter": "title~'Math Academy'"}) if (x.get("title") or "").lower().startswith("math academy")]
    sids = set()
    for co in courses:
        for cl in c.tb_all("/ims/oneroster/rostering/v1p2/classes/", "classes", {"filter": f"course.sourcedId='{co['sourcedId']}'"}):
            for e in c.tb_all("/ims/oneroster/rostering/v1p2/enrollments/", "enrollments", {"filter": f"class.sourcedId='{cl['sourcedId']}'"}):
                if e.get("role") == "student" and (e.get("user") or {}).get("sourcedId"): sids.add(e["user"]["sourcedId"])
    missing = sorted(sids - have); found = 0
    c.log(f"backfill: {len(sids)} students ever seated, {len(missing)} without a store row")
    for s_ in missing:
        if time_left() < 120: break
        try: usr = c.tb(f"/ims/oneroster/rostering/v1p2/users/{s_}").get("user") or {}
        except Exception: continue
        email = (usr.get("email") or usr.get("username") or "").lower(); now = datetime.datetime.now(UTC).isoformat(timespec="seconds")
        d, err = c.ma(f"/students/{urllib.parse.quote(email)}", "ma_lookup") if email else (None, "no email")
        if d is not None and (d.get("student") or {}):
            st = d["student"]; st = {**st, "id": st.get("id") or st.get("studentId")}
            ddb.put_item(TableName=table, Item={"pk": S("student"), "sk": S(s_), "ma": S(json.dumps(st, ensure_ascii=False)), "maId": S(st["id"]), "matchedBy": S("backfill-lookup"),
                                                "courseAgreementAtSnapshot": S(agreement(st, [])), "seats": S("[]"), "isTestUser": {"BOOL": bool((usr.get("metadata") or {}).get("isTestUser"))}, "snapshotAt": S(now), "figuresAsOf": S(now)})
            found += 1
        else:
            ddb.put_item(TableName=table, Item={"pk": S("tb_unmatched"), "sk": S(s_), "reason": S(err or "empty"), "seats": S("[]"), "isTestUser": {"BOOL": bool((usr.get("metadata") or {}).get("isTestUser"))}, "snapshotAt": S(now), "lastTriedAt": S(now), "email": S(email)})
        time.sleep(0.2)
    c.log(f"backfill: matched {found} of {len(missing)} previously unmatched students")
    return {"everSeated": len(sids), "missing": len(missing), "found": found}

def _backfill_meta(ddb, table, start_day, end, status, tasks_this_hop, remaining):
    """meta.backfill: counts every student row with backfilledAt (batch or on-demand), so the figure is true across hops."""
    covered = sum(1 for it in _query_all(ddb, table, "student", "sk, backfilledAt") if "backfilledAt" in it)
    body = {"status": status, "from": start_day, "to": end.isoformat(), "studentsBackfilled": covered, "studentsRemaining": remaining, "updatedAt": datetime.datetime.now(UTC).isoformat(timespec="seconds")}
    if status == "complete": body["finishedAt"] = body["updatedAt"]
    ddb.update_item(TableName=table, Key={"pk": S("meta"), "sk": S("snapshot")}, UpdateExpression="SET backfill = :b", ExpressionAttributeValues={":b": S(json.dumps(body))})

def restore_backfill_markers(ddb, table, start_day="2025-07-01"):
    """After a load that dropped the markers: any student with a day row whose source is backfill gets backfilledAt back (no Math Academy call)."""
    fixed = 0
    for it in _query_all(ddb, table, "student", "sk, maId, backfilledAt"):
        if "backfilledAt" in it: continue
        sid = it["sk"]["S"]
        r = ddb.query(TableName=table, KeyConditionExpression="pk = :p", FilterExpression="#s = :b", ExpressionAttributeNames={"#s": "source"},
                      ExpressionAttributeValues={":p": S(f"actday#{sid}"), ":b": S("backfill")}, ProjectionExpression="sk, fetchedAt")
        rows = r.get("Items") or []
        if not rows: continue
        at = max(x.get("fetchedAt", {}).get("S", "") for x in rows) or datetime.datetime.now(UTC).isoformat(timespec="seconds")
        ddb.update_item(TableName=table, Key={"pk": S("student"), "sk": S(sid)}, UpdateExpression="SET backfilledAt = :t, backfilledFrom = :f", ExpressionAttributeValues={":t": S(at), ":f": S(start_day)}); fixed += 1
    return fixed

def run_backfill(c, ddb, table, start_day, time_left=lambda: 10 ** 9, cursor=None):
    """Per store student with a Math Academy id, pull activity from start_day to today in ~quarter ranges; write task rows under
    their America/Chicago day and recompute day totals. Resumable through a cursor (the last student id done)."""
    end = datetime.datetime.now(CHICAGO).date(); start = datetime.date.fromisoformat(start_day)
    rows = sorted(((it["sk"]["S"], it["maId"]["S"]) for it in _query_all(ddb, table, "student", "sk, maId, backfilledAt") if "maId" in it and "backfilledAt" not in it), key=lambda x: x[0])
    if cursor: rows = [r for r in rows if r[0] > cursor]
    done = 0; tasks_written = 0; last = cursor; days_touched = set()
    for sid, ma_id in rows:
        if time_left() < 150:
            _backfill_meta(ddb, table, start_day, end, "in progress", tasks_written, remaining=len(rows) - done)
            return {"status": "partial", "cursor": last, "studentsDone": done, "tasksWritten": tasks_written, "daysTouched": len(days_touched), "calls": c.calls}
        by_day = {}
        for a, b in _quarters(start, end):
            d, err = c.ma(f"/students/{ma_id}/activity?startDate={a}&endDate={b}", "ma_activity")
            if d is None: continue
            for t in ((d.get("activity") or {}).get("tasks") or []):
                if not t.get("completed"): continue
                by_day.setdefault(_chicago_day(int(t["completed"])), []).append(t)
            time.sleep(0.25)
        items = []
        for day, tasks in by_day.items():
            for t in tasks: items.append({"PutRequest": {"Item": task_item(sid, day, t)}})
            an = lambda k: sum(int((t.get("analysis") or {}).get(k) or 0) for t in tasks)
            items.append({"PutRequest": {"Item": {"pk": S(f"actday#{sid}"), "sk": S(day), "numTasks": {"N": str(len(tasks))},
                                                  "timeElapsedMs": {"N": str(an("timeElapsed"))}, "timeEngagedMs": {"N": str(an("timeEngaged"))}, "timeProductiveMs": {"N": str(an("timeProductive"))},
                                                  "xpAwarded": {"N": str(sum(int(t.get("xpAwarded") or 0) for t in tasks))},
                                                  "questions": {"N": str(sum(int(t.get("questions") or 0) for t in tasks))}, "questionsCorrect": {"N": str(sum(int(t.get("questionsCorrect") or 0) for t in tasks))},
                                                  "windowUtc": S("/".join(x.isoformat() for x in local_day_window(day))), "source": S("backfill"), "fetchedAt": S(datetime.datetime.now(UTC).isoformat(timespec="seconds"))}}})
            days_touched.add(day)
        _batch(ddb, table, items); tasks_written += sum(len(v) for v in by_day.values()); done += 1; last = sid
        ddb.update_item(TableName=table, Key={"pk": S("student"), "sk": S(sid)}, UpdateExpression="SET backfilledAt = :t, backfilledFrom = :f", ExpressionAttributeValues={":t": S(datetime.datetime.now(UTC).isoformat(timespec="seconds")), ":f": S(start_day)})
        if done % 50 == 0: c.log(f"backfill: {done} students, {tasks_written} tasks, {len(days_touched)} distinct days, calls {c.calls['ma_activity']}")
    _backfill_meta(ddb, table, start_day, end, "complete", tasks_written, remaining=0)
    return {"status": "done", "studentsDone": done, "tasksWritten": tasks_written, "daysTouched": len(days_touched), "calls": c.calls}
