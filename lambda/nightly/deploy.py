#!/usr/bin/env python3
"""Deploy the nightly Math Academy store refresh: one Lambda (two modes) + two EventBridge schedules. Idempotent.
Follows _shared/AWS-ACCESS.md (profile ruchibaid, team-dev-* roles under the PowerUserAccess boundary, secrets read by name).

  py -3 lambda/nightly/deploy.py check
  py -3 lambda/nightly/deploy.py create-roles      # team-dev-mathacademy-skill-nightly (lambda) + team-dev-mathacademy-skill-scheduler
  py -3 lambda/nightly/deploy.py deploy            # function + the two schedules
  py -3 lambda/nightly/deploy.py invoke snapshot|activity [day]   # run once now (synchronous, prints the result)
  py -3 lambda/nightly/deploy.py disable|enable    # pause / resume both schedules

Secret: reads the existing `sat-cohort-tracker/ci` (MA_API_KEY + Cognito client + token URL). Nothing here writes a secret."""
import argparse, io, json, pathlib, sys, time, zipfile
import boto3, botocore

HERE = pathlib.Path(__file__).resolve().parent; ROOT = HERE.parent.parent
FN = "mathacademy-timeback-nightly"; TABLE = "mathacademy-timeback-skill-store"; SECRET = "sat-cohort-tracker/ci"
LAMBDA_ROLE = "team-dev-mathacademy-skill-nightly"; SCHED_ROLE = "team-dev-mathacademy-skill-scheduler"
REGION = "us-east-1"; BOUNDARY = "arn:aws:iam::aws:policy/PowerUserAccess"
SCHEDULES = {"mathacademy-timeback-snapshot-nightly": ("cron(0 3 * * ? *)", {"mode": "snapshot", "source": "schedule"}),
             "mathacademy-timeback-activity-nightly": ("cron(45 3 * * ? *)", {"mode": "activity", "source": "schedule"})}
TZ = "America/Chicago"
TAGS = {"project": "mathacademy-timeback-skill", "owner": "ruchi.baid", "purpose": "nightly math academy store refresh"}

ap = argparse.ArgumentParser(); ap.add_argument("cmd", nargs="?", default="check"); ap.add_argument("arg", nargs="*"); ap.add_argument("--profile", default="ruchibaid")
a = ap.parse_args(); a.cmd = a.cmd.lstrip("-")
s = boto3.Session(profile_name=a.profile, region_name=REGION)
iam, lam, sch, sm, sts = s.client("iam"), s.client("lambda"), s.client("scheduler"), s.client("secretsmanager"), s.client("sts")
ACCOUNT = sts.get_caller_identity()["Account"]
fn_arn = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{FN}"
table_arn = f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/{TABLE}"

def get_role(name):
    try: return iam.get_role(RoleName=name)["Role"]["Arn"]
    except botocore.exceptions.ClientError: return None

if a.cmd == "check":
    print("caller", sts.get_caller_identity()["Arn"])
    try:
        keys = set(json.loads(sm.get_secret_value(SecretId=SECRET)["SecretString"]).keys())
        need = {"MA_API_KEY", "AWS_COGNITO_APP_CLIENT_ID", "AWS_COGNITO_CLIENT_SECRET"}
        print(f"secret {SECRET}: present; missing keys: {sorted(need - keys) or 'none'}")
    except botocore.exceptions.ClientError as e: print(f"secret {SECRET}: {e.response['Error']['Code']}")
    for r in (LAMBDA_ROLE, SCHED_ROLE): print("role", r, ":", get_role(r) or "MISSING")
    try: c = lam.get_function_configuration(FunctionName=FN); print(f"lambda {FN}: {c['Runtime']} timeout {c['Timeout']} mem {c['MemorySize']} modified {c['LastModified'][:16]}")
    except botocore.exceptions.ClientError: print(f"lambda {FN}: not deployed")
    for n in SCHEDULES:
        try: d = sch.get_schedule(Name=n); print(f"schedule {n}: {d['ScheduleExpression']} {d.get('ScheduleExpressionTimezone')} {d['State']}")
        except botocore.exceptions.ClientError: print(f"schedule {n}: not created")
    sys.exit(0)

if a.cmd == "create-roles":
    specs = {
        LAMBDA_ROLE: ("lambda.amazonaws.com", ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"], {
            "read-ci-secret": [{"Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:{SECRET}-*"}],
            "store-table": [{"Effect": "Allow", "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem"], "Resource": table_arn}],
            "reinvoke-self": [{"Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": fn_arn}]},
            "mathacademy_timeback nightly store refresh: logs, one secret, the store table, self re-invoke"),
        SCHED_ROLE: ("scheduler.amazonaws.com", [], {"invoke-nightly": [{"Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": fn_arn}]},
                     "lets the EventBridge schedules invoke the nightly function"),
    }
    for name, (svc, managed, inline, desc) in specs.items():
        trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": svc}, "Action": "sts:AssumeRole"}]}
        if get_role(name): print("role exists:", name)
        else:
            iam.create_role(RoleName=name, AssumeRolePolicyDocument=json.dumps(trust), Description=desc, PermissionsBoundary=BOUNDARY, Tags=[{"Key": k, "Value": v} for k, v in TAGS.items()])
            print("created role:", name)
        for m in managed: iam.attach_role_policy(RoleName=name, PolicyArn=m)
        for pn, st in inline.items(): iam.put_role_policy(RoleName=name, PolicyName=pn, PolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": st}))
        print("  policies:", [p.split("/")[-1] for p in managed] + list(inline))
    print("waiting 10 s for IAM"); time.sleep(10); sys.exit(0)

def zip_bytes():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(HERE / "handler.py", "handler.py"); z.write(ROOT / "store" / "snapshot_lib.py", "snapshot_lib.py"); z.write(ROOT / "store" / "agreement.py", "agreement.py")
    return buf.getvalue()

def wait():
    lam.get_waiter("function_updated").wait(FunctionName=FN)

if a.cmd == "deploy":
    role = get_role(LAMBDA_ROLE) or sys.exit("run create-roles first"); srole = get_role(SCHED_ROLE) or sys.exit("run create-roles first")
    code = zip_bytes(); print(f"zip {len(code):,} bytes")
    env = {"Variables": {"TABLE": TABLE, "SECRET_NAME": SECRET, "TZ_OFFSET_HOURS": "-5", "SELF_FUNCTION": FN}}
    try:
        lam.get_function_configuration(FunctionName=FN)
        lam.update_function_configuration(FunctionName=FN, Environment=env, Timeout=900, MemorySize=512, Runtime="python3.12", Handler="handler.handler", Role=role); wait()
        lam.update_function_code(FunctionName=FN, ZipFile=code); wait(); print("function updated")
    except botocore.exceptions.ClientError:
        for i in range(6):
            try:
                lam.create_function(FunctionName=FN, Runtime="python3.12", Role=role, Handler="handler.handler", Code={"ZipFile": code}, Timeout=900, MemorySize=512,
                                    Environment=env, Tags=TAGS, Description="mathacademy_timeback: nightly Math Academy snapshot + activity pull into the store table"); break
            except botocore.exceptions.ClientError as e:
                if "role" in str(e).lower() and i < 5: time.sleep(5); continue
                raise
        lam.get_waiter("function_active").wait(FunctionName=FN); print("function created")
    for name, (cron, payload) in SCHEDULES.items():
        kw = dict(Name=name, ScheduleExpression=cron, ScheduleExpressionTimezone=TZ, FlexibleTimeWindow={"Mode": "OFF"},
                  Target={"Arn": fn_arn, "RoleArn": srole, "Input": json.dumps(payload), "RetryPolicy": {"MaximumRetryAttempts": 1}}, State="ENABLED",
                  Description=f"mathacademy_timeback nightly {payload['mode']}")
        try: sch.get_schedule(Name=name); sch.update_schedule(**kw); print("schedule updated:", name, cron, TZ)
        except botocore.exceptions.ClientError: sch.create_schedule(**kw); print("schedule created:", name, cron, TZ)
    sys.exit(0)

if a.cmd == "invoke":
    mode = a.arg[0] if a.arg else "snapshot"; payload = {"mode": mode, "source": "manual"}
    if len(a.arg) > 1: payload["day"] = a.arg[1]
    if len(a.arg) > 2 and a.arg[2] == "force": payload["force"] = True
    lam_long = s.client("lambda", config=botocore.config.Config(read_timeout=920, connect_timeout=10, retries={"max_attempts": 0}))
    r = lam_long.invoke(FunctionName=FN, InvocationType="RequestResponse", Payload=json.dumps(payload).encode(), LogType="Tail")
    print(r["Payload"].read().decode("utf-8")[:4000])
    import base64; print("--- log tail ---"); print(base64.b64decode(r.get("LogResult", "")).decode("utf-8")[-3000:])
    sys.exit(0)

if a.cmd in ("disable", "enable"):
    for name in SCHEDULES:
        d = sch.get_schedule(Name=name)
        sch.update_schedule(Name=name, ScheduleExpression=d["ScheduleExpression"], ScheduleExpressionTimezone=d.get("ScheduleExpressionTimezone"),
                            FlexibleTimeWindow=d["FlexibleTimeWindow"], Target=d["Target"], State="ENABLED" if a.cmd == "enable" else "DISABLED")
        print(name, a.cmd + "d")
    sys.exit(0)
sys.exit("unknown command")
