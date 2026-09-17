"""Course agreement between a Math Academy record and a set of Timeback seats. One implementation, used by
pull_snapshot.py (at snapshot time) and mirrored in lambda/index.mjs (live). Keep the two in step.

Values: 'agree' | 'disagree' | 'disagree, math academy course completed' | 'no current timeback seat' | 'math academy has no current course'
State of the Math Academy course: 'not started' (progress 0 and xpRemaining 0 and not completed: the course is assigned, no task done yet,
figures not computed) | 'completed' | 'in progress'."""
import re

def norm(s):
    n = (s or "").lower().strip()
    n = re.sub(r"^math academy\s*-\s*", "", n); n = re.sub(r"\s+class$", "", n); n = re.sub(r"\s+math$", "", n)
    return re.sub(r"^(\d+)(st|nd|rd|th)\s+grade$", r"\1th grade", n)

def ma_state(cc):
    cc = cc or {}
    if cc.get("completed"): return "completed"
    if (cc.get("progress") or 0) == 0 and (cc.get("xpRemaining") or 0) == 0: return "not started"
    return "in progress"

def agreement(ma_record, seat_course_names):
    cc = (ma_record or {}).get("currentCourse") or {}
    name = cc.get("name")
    if not name: return "math academy has no current course"
    if not seat_course_names: return "no current timeback seat"
    if any(norm(n) == norm(name) for n in seat_course_names): return "agree"
    return "disagree, math academy course completed" if cc.get("completed") else "disagree"

def summarise(students, tb_unmatched):
    """counts by agreement value (rows vocabulary) overall and per Timeback course sourcedId; no student values."""
    overall, by_course = {}, {}
    def bump(d, k): d[k] = d.get(k, 0) + 1
    for st in students:
        k = st["courseAgreementAtSnapshot"]; bump(overall, k)
        for seat in st["seats"]:
            c = by_course.setdefault(seat["courseSourcedId"] or "unknown", {"courseName": seat["courseName"], "students": 0, "testUsers": 0, "byAgreement": {}, "maNotStarted": 0})
            c["students"] += 1; c["testUsers"] += 1 if st["isTestUser"] else 0; bump(c["byAgreement"], k)
            if ma_state(st["mathAcademy"].get("currentCourse")) == "not started": c["maNotStarted"] += 1
    for u in tb_unmatched:
        bump(overall, "no math academy record")
        for seat in u["seats"]:
            c = by_course.setdefault(seat["courseSourcedId"] or "unknown", {"courseName": seat["courseName"], "students": 0, "testUsers": 0, "byAgreement": {}, "maNotStarted": 0})
            c["students"] += 1; c["testUsers"] += 1 if u["isTestUser"] else 0; bump(c["byAgreement"], "no math academy record")
    return overall, by_course
