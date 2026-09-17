"""Course agreement and course state for a Math Academy record against a set of Timeback seats. One implementation,
used by snapshot_lib.py (snapshot time) and mirrored in lambda/index.mjs (live). Keep the two in step.

courseAgreement values:
  'agree' | 'agree, math academy course completed' | 'disagree' | 'disagree, math academy course completed'
  | 'no current timeback seat' | 'math academy has no current course' | 'no math academy record' (unmatched rows) | 'not in snapshot' (front only)
mathAcademyState values (Math Academy's own figures, read as):
  'completed'                      currentCourse.completed is set
  'at 100, not marked complete'    progress >= 0.995 and not completed (Timeback may show a rounded 100)
  'not started'                    progress == 0 and not completed (progress null, as on SAT Math Prep, reads 'in progress') (xpRemaining is either 0 = figures not computed, or the full course size)
  'in progress'                    everything else
"""
import re

AGREEMENT_VALUES = ["agree", "agree, math academy course completed", "disagree", "disagree, math academy course completed",
                    "no current timeback seat", "math academy has no current course", "no math academy record", "not in snapshot"]

def norm(s):
    n = (s or "").lower().strip()
    n = re.sub(r"^math academy\s*-\s*", "", n); n = re.sub(r"\s+class$", "", n); n = re.sub(r"\s+math$", "", n)
    return re.sub(r"^(\d+)(st|nd|rd|th)\s+grade$", r"\1th grade", n)

def ma_state(cc):
    cc = cc or {}
    if not cc: return None
    if cc.get("completed"): return "completed"
    p = cc.get("progress")
    if p is None: return "in progress"          # SAT Math Prep serves progress null (estimatedScore instead): no state can be read from it
    if p >= 0.995: return "at 100, not marked complete"
    if p == 0: return "not started"
    return "in progress"

def agreement(ma_record, seat_course_names):
    cc = (ma_record or {}).get("currentCourse") or {}
    name = cc.get("name")
    if not name: return "math academy has no current course"
    if not seat_course_names: return "no current timeback seat"
    done = bool(cc.get("completed"))
    if any(norm(n) == norm(name) for n in seat_course_names): return "agree, math academy course completed" if done else "agree"
    return "disagree, math academy course completed" if done else "disagree"

def _bump(d, k): d[k] = d.get(k, 0) + 1

def summarise(students, tb_unmatched):
    """counts by agreement value overall and per Timeback course sourcedId, with a non-test split; no student values."""
    overall, by_course = {}, {}
    def course(seat):
        return by_course.setdefault(seat["courseSourcedId"] or "unknown", {"courseName": seat["courseName"], "students": 0, "testUsers": 0, "byAgreement": {}, "maNotStarted": 0,
                                                                            "nonTest": {"students": 0, "byAgreement": {}, "maNotStarted": 0, "byMathAcademyState": {}}})
    for st in students:
        k = st["courseAgreementAtSnapshot"]; _bump(overall, k)
        state = ma_state(st["mathAcademy"].get("currentCourse"))
        for seat in st["seats"]:
            c = course(seat); c["students"] += 1; _bump(c["byAgreement"], k)
            if state == "not started": c["maNotStarted"] += 1
            if st["isTestUser"]: c["testUsers"] += 1
            else:
                c["nonTest"]["students"] += 1; _bump(c["nonTest"]["byAgreement"], k); _bump(c["nonTest"]["byMathAcademyState"], state or "unknown")
                if state == "not started": c["nonTest"]["maNotStarted"] += 1
    for u in tb_unmatched:
        _bump(overall, "no math academy record")
        for seat in u["seats"]:
            c = course(seat); c["students"] += 1; _bump(c["byAgreement"], "no math academy record")
            if u["isTestUser"]: c["testUsers"] += 1
            else: c["nonTest"]["students"] += 1; _bump(c["nonTest"]["byAgreement"], "no math academy record"); _bump(c["nonTest"]["byMathAcademyState"], "no math academy record")
    return overall, by_course

def ma_courses(students, ma_unmatched):
    """Math Academy course id -> name, from every record seen (no student values)."""
    out = {}
    for rec in [s["mathAcademy"] for s in students] + list(ma_unmatched):
        cc = (rec or {}).get("currentCourse") or {}
        if cc.get("id") is not None and cc.get("name"): out[str(cc["id"])] = cc["name"]
    return dict(sorted(out.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 10 ** 9))
