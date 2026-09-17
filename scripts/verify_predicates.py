#!/usr/bin/env python3
"""Self-run the dss registry's four keyless predicates against a deployed front, before POSTing /dss/register.

  1. {base} or {base}/skill returns JSON with top-level what, when, why, how (+ feedback top-level or nested)
  2. the dictionary and enablement pointers resolve (200, non-empty)
  3. why.sha256 equals sha256 of the live GET https://data-source-skills.vercel.app/contract body
  4. feedback: a keyless GET listing on our origin returns a plain JSON array; the POST route is declared open
     (no credential) and declared caps meet the pointer-form floor (title 200 / body 10000 declared here)

Usage: py -3 scripts/verify_predicates.py https://<your-base>"""
import hashlib, json, sys, urllib.request, urllib.error

base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else sys.exit("usage: verify_predicates.py <base>")
def get(url, accept="application/json"):
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "mathacademy_timeback-verify"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, r.read(), dict(r.headers)
ok = True
def check(cond, msg):
    global ok
    print(("PASS " if cond else "FAIL ") + msg); ok = ok and cond

# 1
front = None
for u in (base + "/skill", base):
    try:
        s, b, _ = get(u); j = json.loads(b)
        if all(k in j for k in ("what", "when", "why", "how")): front = j; print(f"front resolved at {u}"); break
    except Exception as e:
        print(f"  {u}: {e!r}")
check(front is not None, "1 five-clause front (what/when/why/how top-level)")
if not front: sys.exit(1)
check("feedback" in front or "feedback" in front.get("how", {}), "1b feedback clause present")
# 2
for kind in ("dictionary", "enablement"):
    url = front["how"].get(kind) or front.get("documents", {}).get(kind.upper() + ".md", {}).get("url")
    try:
        s, b, h = get(url, "text/markdown"); check(s == 200 and len(b) > 1000, f"2 {kind} resolves at {url} ({len(b)} bytes)")
        dsha = hashlib.sha256(b).hexdigest(); pinned = front.get("documents", {}).get(kind.upper() + ".md", {}).get("sha256")
        if pinned: check(pinned == dsha, f"2b {kind} pinned sha matches served bytes")
        if h.get("X-Doc-SHA256"): check(h["X-Doc-SHA256"] == dsha, f"2c {kind} X-Doc-SHA256 header matches body")
    except Exception as e:
        check(False, f"2 {kind} fetch failed: {e!r}")
# 3
s, b, h = get("https://data-source-skills.vercel.app/contract", "text/markdown")
live = hashlib.sha256(b).hexdigest()
check(front["why"].get("sha256") == live, f"3 why.sha256 == live contract sha ({live[:12]}…, X-Doc-Version {h.get('X-Doc-Version')})")
# 4
fb = front.get("feedback") or front["how"].get("feedback") or {}
open_url = (fb.get("open") or "").split()[1] if fb.get("open", "").startswith("GET ") else fb.get("open", "").split(" ")[0]
try:
    s, b, _ = get(open_url); j = json.loads(b)
    check(isinstance(j, list), f"4a GET listing at {open_url} is a plain array ({len(j) if isinstance(j, list) else 'not a list'} items)")
except Exception as e:
    check(False, f"4a listing fetch failed: {e!r}")
report = fb.get("report", "")
check("no credential" in report.lower() or "keyless" in report.lower(), "4b report route declared open (no credential)")
caps = fb.get("caps") or {}
check(isinstance(caps.get("title"), int) and isinstance(caps.get("body"), int) and caps["body"] >= 4000, f"4c caps declared as integers under title/body and body >= pointer-form floor ({caps})")
print("\nALL PASS" if ok else "\nSOME CHECKS FAILED")
sys.exit(0 if ok else 1)
