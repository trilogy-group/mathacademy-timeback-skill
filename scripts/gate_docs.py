"""Documentation gate: run before every front deploy (lambda/deploy.py calls it). Exit 1 on any failure.

Four checks, each born from a class of defect the independent cold rounds kept finding:
  1. documented-but-not-served: every backticked identifier in ENABLEMENT Part A, the dictionary's store section and the front's how.store
     must appear in the code that serves it (lambda/index.mjs, store/*.py, lambda/nightly/handler.py), unless allow-listed as a reader-side
     output name in scripts/gate_allowlist.json;
  2. one-fact-two-ways: a set of facts each stated in several documents must appear in one form only (the allow-listed form), and none of
     the known stale variants may appear anywhere;
  3. leftover phrases: banned phrases from earlier versions of the documents must not appear in any served text;
  4. absolute claims: every sentence with never / always / only / every / exactly / all in the served documents must be on the reviewed list
     (scripts/gate_allowlist.json -> absolutes, keyed by a hash of the sentence); a new absolute claim fails the gate until it is reviewed
     and added (py -3 scripts/gate_docs.py --accept-absolutes after reading them).

Usage: py -3 scripts/gate_docs.py [--accept-absolutes] [--live]   (--live also reads the deployed /store and compares its keys)
"""
import hashlib, json, pathlib, re, sys, urllib.request
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ROOT = pathlib.Path(__file__).resolve().parent.parent
ALLOW = ROOT / "scripts" / "gate_allowlist.json"
allow = json.loads(ALLOW.read_text(encoding="utf-8")) if ALLOW.exists() else {"readerOutputNames": [], "absolutes": {}}
fails = []

def read(p): return (ROOT / p).read_text(encoding="utf-8")
EN, DI, AB = read("ENABLEMENT.md"), read("DICTIONARY.md"), read("about.html")
TPL = read("skill.template.json"); XP = read("reference/course-xp-size.json")
CODE = read("lambda/index.mjs") + read("store/snapshot_lib.py") + read("store/agreement.py") + read("lambda/nightly/handler.py")
SERVED = {"ENABLEMENT.md": EN, "DICTIONARY.md": DI, "about.html": AB, "skill.template.json": TPL, "reference/course-xp-size.json": XP}
def strip_html(t): return re.sub(r"<[^>]+>", " ", t)

# ---------------------------------------------------------------- 1. documented but not served
partA = EN[EN.find("## Part A"):EN.find("## Part B")]
store_sec = DI[DI.find("### The Math Academy snapshot store"):DI.find("### assessmentResult (Caliper-derived)")]
tpl = json.loads(TPL); how_store = json.dumps(tpl["how"]["store"])
WIRE_VOCAB = {"lesson", "review", "quiz", "multistep", "placement", "exam", "supplemental", "known", "lookup", "username", "email", "name", "agree", "disagree",
              "true", "false", "null", "manual", "complete", "completed", "open", "recovered", "pulled", "error", "future", "partial", "from", "to", "since", "date", "refresh", "minimal",
              "new", "stopped", "not", "id", "user", "cache", "index", "value", "window", "clock", "kind", "state", "message", "ActivityEvent", "TimeSpentEvent", "factsByApp", "activityMetrics",
              "timeSpentMetrics", "masteredUnits", "inactiveSeconds", "enrollmentId", "userId", "wasteSeconds", "xpEarned", "activityName", "datetime", "weekDate", "timezone", "beginDate", "endDate",
              "totalXp", "metrics", "isTestUser", "grades", "userProfiles", "givenName", "familyName", "identifier", "score", "totalQuestions", "correctQuestions", "pctCompleteApp", "sourcedId",
              "activeSeconds", "scoreDate", "dateLastModified", "status", "role", "tobedeleted", "active", "primary", "metadata", "sensor", "originalObjectId", "appName", "filter", "limit", "offset",
              "sort", "orderBy", "studentId", "results", "users", "enrollments", "classes", "courses", "facts", "apps"}
idents = set()
for src in (partA, store_sec, how_store):
    for m in re.finditer(r"`([A-Za-z][A-Za-z0-9_.\[\]]*)`", src):
        tok = m.group(1).split(".")[-1].replace("[]", "")
        if re.fullmatch(r"[a-z][A-Za-z0-9_]{2,}", tok) and tok not in WIRE_VOCAB: idents.add(tok)
    for m in re.finditer(r"\b([a-z][A-Za-z0-9]{3,}[A-Z][A-Za-z0-9]*)\b", src):    # camelCase words outside backticks too
        if m.group(1) not in WIRE_VOCAB: idents.add(m.group(1))
unserved = sorted(t for t in idents if t not in CODE and t not in allow["readerOutputNames"])
if unserved: fails.append(f"[1 documented-but-not-served] {len(unserved)} identifiers named in Part A / dictionary store section / how.store are not in the code and not allow-listed as reader-side output names: {unserved}")

# ---------------------------------------------------------------- 2. one fact, one form
FACTS = [
 ("accuracy band", r"64 percent too high to 67 percent too low", [r"64 percent too low", r"15 percent (too )?high to 64", r"15 percent below and 114", r"15 percent high to 53"]),
 ("late-row share", r"3 to 8 percent", [r"about 7 percent of (a day|Timeback)", r"about 7 percent of a day", r"3 to 7 percent"]),
 ("completed at low progress", r"69, 81 and even 0 percent", [r"69 and 80 percent", r"69 and 81 percent", r"69 to 81 percent"]),
 ("pace good zone", r"0\.9 to 1\.1", [r"0\.8 to 1\.2"]),
 ("staleAfterDays", r"two days", [r"seven days as served", r"staleAfterDays.{0,20}7\b"]),
 ("backfill start", r"2025-07-01", [r"backfilled from 2026-09"]),
 ("nightly activity store began", r"2026-09-15", []),
 ("store began", r"2026-09-17", []),
 ("nightly times", r"03:00", [r"3:15 am", r"04:00 America"]),
 ("results per day", r"about a thousand Math Academy results a day averaged", [r"on the order of two thousand Math Academy results a day"]),
 ("nightly cost", r"800 to 900", [r"roughly 400\b", r"a few hundred times a night"]),
 ("traps count", r"27 named traps", [r"26 named traps", r"25 named traps"]),
 ("test share", r"about a third of seats", [r"from a fifth to two fifths by course;"]),
 ("SAT Math Prep xpRemaining", r"UNRELIABLE there|unreliable there|treat XP left as unknown", [r"IS served and exact on SAT Math Prep", r"including on SAT Math Prep; read it first", r"served on SAT Math Prep too\)\."]),
 ("finishers default since", r"defaults to all time when omitted", [r"defaults to the beginning of the store"]),
]
for label, canonical, stale in FACTS:
    where = [n for n, t in SERVED.items() if re.search(canonical, strip_html(t))]
    for rx in stale:
        for n, t in SERVED.items():
            if re.search(rx, strip_html(t)): fails.append(f"[2 one-fact-two-ways] '{label}': stale form /{rx}/ still in {n} (canonical form present in {where or 'nowhere'})")

# ---------------------------------------------------------------- 3. leftover phrases
BANNED = [r"results-first", r"never reaches Math Academy", r"\bex\. \d+\b", r"\bexample \d+\b", r"twelve worked recipes", r"count finishers from results", r"The only served flag",
          r"the exact XP left", r"two activity calls per student", r"Timeback receives only the first", r"most FINISHED students are absent", r"examples 10 to 12", r"'no credential'",
          r"shows only the snapshot's own buckets", r"only when it has finished", r"Nothing is called during the school day except a first-time knowledge map or a missing student\.", r"Every task a student completes on Math Academy (reaches|is sent to) Timeback", r"No figures read off the wire in the documents", r"no figure of this document's travels with it", r"a student progression has moved out of Math Academy, or left seatless, is otherwise absent"]
for rx in BANNED:
    for n, t in SERVED.items():
        for m in re.finditer(rx, t):
            ctx = t[max(0, m.start() - 60):m.end() + 40].replace("\n", " ")
            fails.append(f"[3 leftover phrase] /{rx}/ in {n}: …{ctx}…")

# ---------------------------------------------------------------- 4. absolute claims must be reviewed
ABS = re.compile(r"\b(never|always|only|every|exactly|all)\b", re.I)
sentences = {}
for n, t in SERVED.items():
    plain = strip_html(t) if n.endswith(".html") else t
    for s in re.split(r"(?<=[.!?])\s+|\n", plain):
        s = s.strip()
        if len(s) < 25 or not ABS.search(s): continue
        if n.endswith(".json") and ("{{" in s and "}}" in s): s = re.sub(r"\{\{[A-Z_]+\}\}", "X", s)
        h = hashlib.sha1(s.encode("utf-8")).hexdigest()[:12]
        sentences[h] = (n, s)
new_abs = {h: v for h, v in sentences.items() if h not in allow["absolutes"]}
if "--accept-absolutes" in sys.argv:
    for h, (n, s) in new_abs.items(): allow["absolutes"][h] = {"doc": n, "sentence": s[:300], "reviewed": "owner run"}
    stale_abs = [h for h in allow["absolutes"] if h not in sentences]
    for h in stale_abs: allow["absolutes"].pop(h)
    ALLOW.write_text(json.dumps(allow, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"accepted {len(new_abs)} new absolute claims, dropped {len(stale_abs)} that no longer appear; {len(allow['absolutes'])} on the reviewed list")
    new_abs = {}
if new_abs:
    fails.append(f"[4 unreviewed absolute claims] {len(new_abs)} sentence(s) with never/always/only/every/exactly/all are not on the reviewed list; read them, verify or soften, then run --accept-absolutes:")
    for h, (n, s) in list(new_abs.items())[:40]: fails.append(f"    {n}: {s[:220]}")

# ---------------------------------------------------------------- optional live: keys the front serves vs the front's own description
if "--live" in sys.argv:
    try:
        base = json.loads(read("deploy.json"))["base"].rstrip("/")
        st = json.loads(urllib.request.urlopen(base + "/store", timeout=60).read())
        for k in ("snapshotAt", "stale", "activityLastDate", "lastActivityRun", "backfill", "schedule", "health", "readCalls", "history"):
            if k not in st: fails.append(f"[live] /store lacks documented key {k}")
        for k in ("daysPulled", "maCalls", "day", "windowUtc", "rePull"):
            if k not in (st.get("lastActivityRun") or {}): fails.append(f"[live] /store lastActivityRun lacks documented key {k}")
    except Exception as e: fails.append(f"[live] could not read /store: {e}")

if fails:
    print("GATE FAILED:"); [print(" -", f) for f in fails]; sys.exit(1)
print(f"GATE PASSED: {len(idents)} identifiers served, {len(FACTS)} facts in one form, {len(BANNED)} banned phrases absent, {len(sentences)} absolute claims all reviewed")
