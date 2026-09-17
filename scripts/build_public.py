#!/usr/bin/env python3
"""Assemble the static asset folder the worker serves: public/skill.json, public/DICTIONARY.md,
public/ENABLEMENT.md, public/reference/*.json. Runs build_front.py first."""
import pathlib, shutil, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
subprocess.check_call([sys.executable, str(ROOT / "scripts" / "build_front.py")])
pub = ROOT / "public"
if pub.exists(): shutil.rmtree(pub)
(pub / "reference").mkdir(parents=True)
for f in ("skill.json", "DICTIONARY.md", "ENABLEMENT.md", "about.html"):
    shutil.copy(ROOT / f, pub / f)
for f in (ROOT / "reference").glob("*.json"):
    shutil.copy(f, pub / "reference" / f.name)
print("public/ assembled:", sorted(p.relative_to(pub).as_posix() for p in pub.rglob("*") if p.is_file()))
