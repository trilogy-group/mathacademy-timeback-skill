#!/usr/bin/env python3
"""Render skill.json from skill.template.json.

Fills: {{BASE}} and {{REPO}} from deploy.json, {{CONTRACT_SHA256}} / {{CONTRACT_VERSION}} from a live
GET of the dss contract (never copied from a registry row), {{DICTIONARY_SHA256}} / {{ENABLEMENT_SHA256}}
from the exact bytes of the two documents, {{GIT_VERSION}} from `git rev-parse --short HEAD`, {{VERSION}}
as today's date. Run before every deploy.

Usage: py -3 scripts/build_front.py   (reads deploy.json beside skill.template.json)"""
import datetime, hashlib, json, pathlib, subprocess, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
cfg = json.loads((ROOT / "deploy.json").read_text(encoding="utf-8"))
base, repo = cfg["base"].rstrip("/"), cfg["repo"]

req = urllib.request.Request("https://data-source-skills.vercel.app/contract", headers={"User-Agent": "mathacademy_timeback-build"})
with urllib.request.urlopen(req, timeout=60) as r:
    body = r.read(); ver = r.headers.get("X-Doc-Version", "")
contract_sha = hashlib.sha256(body).hexdigest()
if r.headers.get("X-Doc-Sha256") and r.headers.get("X-Doc-Sha256") != contract_sha:
    sys.exit(f"contract body sha {contract_sha} != served X-Doc-Sha256 {r.headers.get('X-Doc-Sha256')}")

def sha(p): return hashlib.sha256((ROOT / p).read_bytes()).hexdigest()
try:
    git = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
except Exception:
    git = "uncommitted"

t = (ROOT / "skill.template.json").read_text(encoding="utf-8")
for k, v in {"BASE": base, "REPO": repo, "CONTRACT_SHA256": contract_sha, "CONTRACT_VERSION": ver,
             "DICTIONARY_SHA256": sha("DICTIONARY.md"), "ENABLEMENT_SHA256": sha("ENABLEMENT.md"),
             "GIT_VERSION": git, "VERSION": datetime.date.today().isoformat()}.items():
    t = t.replace("{{" + k + "}}", v)
json.loads(t)  # must be valid JSON
(ROOT / "skill.json").write_text(t, encoding="utf-8")
print(f"skill.json written: base={base} repo={repo} contract={contract_sha[:12]} ({ver}) git={git}")
