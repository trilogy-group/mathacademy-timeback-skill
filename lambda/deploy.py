#!/usr/bin/env python3
"""Deploy the mathacademy_timeback front as one AWS Lambda with a public function URL.

Follows _shared/AWS-ACCESS.md: profile ruchibaid, region us-east-1, role in the team-dev-* namespace with the
PowerUserAccess permissions boundary, least privilege (one secret, one function), tags without parentheses.
The GitHub token is NOT handled here: the function reads it at runtime from Secrets Manager (SECRET_NAME/SECRET_KEY).

  py -3 lambda/deploy.py --check          # identity, secret exists (name only), role/function presence
  py -3 lambda/deploy.py --create-roles   # team-dev-mathacademy-skill-lambda (trust lambda; logs + GetSecretValue on the one secret)
  py -3 lambda/deploy.py deploy           # build public/, zip handler+public, create/update function, ensure function URL (auth NONE), print URL
  py -3 lambda/deploy.py --url            # print the function URL
"""
import argparse, io, json, pathlib, subprocess, sys, time, zipfile
import boto3, botocore

ROOT = pathlib.Path(__file__).resolve().parent.parent
FN = "mathacademy-timeback-skill"
ROLE = "team-dev-mathacademy-skill-lambda"
SECRET = "sat-cohort-tracker/ci"          # existing secret; key GITHUB_TOKEN (owner-filled)
SECRET_KEY = "GITHUB_TOKEN"
REPO = "trilogy-group/mathacademy-timeback-skill"
TAGS = {"project": "mathacademy-timeback-skill", "owner": "ruchi.baid", "purpose": "dss data source skill front"}
BOUNDARY = "arn:aws:iam::aws:policy/PowerUserAccess"

ap = argparse.ArgumentParser(); ap.add_argument("cmd", nargs="?", default="check"); ap.add_argument("--profile", default="ruchibaid")
a = ap.parse_args([x.lstrip("-") if x in ("--check", "--create-roles", "--url") else x for x in sys.argv[1:]])
a.cmd = "--" + a.cmd if a.cmd in ("check", "create-roles", "url") else a.cmd
s = boto3.Session(profile_name=a.profile, region_name="us-east-1")
iam, lam, sm, sts = s.client("iam"), s.client("lambda"), s.client("secretsmanager"), s.client("sts")
acct = sts.get_caller_identity()["Account"]

def role_arn():
    try: return iam.get_role(RoleName=ROLE)["Role"]["Arn"]
    except botocore.exceptions.ClientError: return None

def fn_exists():
    try: return lam.get_function(FunctionName=FN)["Configuration"]
    except botocore.exceptions.ClientError: return None

def url():
    try: return lam.get_function_url_config(FunctionName=FN)["FunctionUrl"]
    except botocore.exceptions.ClientError: return None

if a.cmd == "--check":
    print("account", acct, "| caller", sts.get_caller_identity()["Arn"])
    d = sm.describe_secret(SecretId=SECRET); print("secret:", d["Name"], d["ARN"])
    print("role:", role_arn() or "MISSING"); print("function:", (fn_exists() or {}).get("FunctionArn") or "MISSING"); print("url:", url() or "MISSING")
    sys.exit(0)

if a.cmd == "--create-roles":
    if role_arn():
        print("role exists:", role_arn())
    else:
        trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]}
        r = iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=json.dumps(trust), PermissionsBoundary=BOUNDARY,
                            Description="mathacademy_timeback dss skill front: serve docs + feedback wire", Tags=[{"Key": k, "Value": v} for k, v in TAGS.items()])
        print("created role", r["Role"]["Arn"])
    iam.attach_role_policy(RoleName=ROLE, PolicyArn="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole")
    secret_arn = sm.describe_secret(SecretId=SECRET)["ARN"]
    iam.put_role_policy(RoleName=ROLE, PolicyName="read-one-secret", PolicyDocument=json.dumps({
        "Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": secret_arn}]}))
    print("policies attached (basic execution + GetSecretValue on", SECRET, ")"); sys.exit(0)

if a.cmd == "deploy":
    subprocess.check_call([sys.executable, str(ROOT / "scripts" / "build_public.py")])
    try: git = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception: git = "unversioned"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(ROOT / "lambda" / "index.mjs", "index.mjs")
        for p in (ROOT / "public").rglob("*"):
            if p.is_file(): z.write(p, "public/" + p.relative_to(ROOT / "public").as_posix())
    code = buf.getvalue(); print(f"zip: {len(code):,} bytes")
    env = {"Variables": {"REPO": REPO, "SOURCE": "mathacademy_timeback", "SECRET_NAME": SECRET, "SECRET_KEY": SECRET_KEY, "GIT_VERSION": git}}
    arn = role_arn() or sys.exit("role missing: run --create-roles first")
    if fn_exists():
        lam.update_function_configuration(FunctionName=FN, Environment=env, Timeout=30, MemorySize=256, Runtime="nodejs20.x", Handler="index.handler", Role=arn)
        w = lam.get_waiter("function_updated"); w.wait(FunctionName=FN)
        lam.update_function_code(FunctionName=FN, ZipFile=code); w.wait(FunctionName=FN); print("function updated")
    else:
        for i in range(6):   # a fresh role can take a few seconds to become passable
            try:
                lam.create_function(FunctionName=FN, Runtime="nodejs20.x", Role=arn, Handler="index.handler", Code={"ZipFile": code}, Timeout=30, MemorySize=256,
                                    Environment=env, Tags=TAGS, Description="mathacademy_timeback dss data source skill front (docs + feedback wire)")
                break
            except botocore.exceptions.ClientError as e:
                if "role" in str(e).lower() and i < 5: time.sleep(5); continue
                raise
        lam.get_waiter("function_active").wait(FunctionName=FN); print("function created")
    if not url():
        lam.create_function_url_config(FunctionName=FN, AuthType="NONE", Cors={"AllowOrigins": ["*"], "AllowMethods": ["GET", "POST"], "AllowHeaders": ["content-type"]})
        try:
            lam.add_permission(FunctionName=FN, StatementId="public-url", Action="lambda:InvokeFunctionUrl", Principal="*", FunctionUrlAuthType="NONE")
        except botocore.exceptions.ClientError as e:
            if "ResourceConflict" not in str(e): raise
        print("function URL created")
    print("URL:", url()); sys.exit(0)

if a.cmd == "--url":
    print(url()); sys.exit(0)
sys.exit("unknown command")
