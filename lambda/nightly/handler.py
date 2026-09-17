"""Nightly Math Academy store refresh (AWS Lambda, python3.12, 900 s). Two modes, chosen by event["mode"]:
  snapshot  - bulk list + Timeback roster + match + write (store/snapshot_lib.run_snapshot)
  activity  - per-task engaged/productive time for every student active on event["day"] (default: yesterday, America/Chicago),
              resumable; re-invokes itself asynchronously when the time budget runs out.
Secrets: one Secrets Manager secret (SECRET_NAME) with MA_API_KEY, AWS_COGNITO_APP_CLIENT_ID, AWS_COGNITO_CLIENT_SECRET, ONEROSTER_TOKEN_URL.
Env: TABLE, SECRET_NAME, TZ_OFFSET_HOURS (default -5), SELF_FUNCTION (for re-invoke)."""
import datetime, json, os
import boto3
import snapshot_lib as lib

TABLE = os.environ.get("TABLE", "mathacademy-timeback-skill-store")
SECRET = os.environ.get("SECRET_NAME", "sat-cohort-tracker/ci")
TZ_OFF = int(os.environ.get("TZ_OFFSET_HOURS", "-5"))
ddb = boto3.client("dynamodb"); sm = boto3.client("secretsmanager"); lam = boto3.client("lambda")

def creds():
    return json.loads(sm.get_secret_value(SecretId=SECRET)["SecretString"])

def yesterday_local():
    now_local = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=TZ_OFF)
    return (now_local.date() - datetime.timedelta(days=1)).isoformat()

def handler(event, context):
    event = event or {}
    mode = event.get("mode", "snapshot")
    time_left = (lambda: context.get_remaining_time_in_millis() / 1000) if context else (lambda: 10 ** 9)
    c = lib.Clients(creds(), log=print)
    if mode == "snapshot":
        snap = lib.run_snapshot(c, ddb, TABLE, time_left=time_left, lookup=not event.get("noLookup"), nightly=True)
        deferred = snap["counts"]["tbUnmatchedByReason"].get("deferred: out of time tonight", 0)
        return {"mode": mode, "snapshotAt": snap["snapshotAt"], "counts": snap["counts"], "calls": c.calls, "deferredLookups": deferred}
    if mode == "activity":
        day = event.get("day") or yesterday_local()
        r = lib.run_activity(c, ddb, TABLE, day, tz_offset_hours=TZ_OFF, time_left=time_left)
        if r.get("status") == "partial" and os.environ.get("SELF_FUNCTION") and int(event.get("hop", 0)) < 8:
            lam.invoke(FunctionName=os.environ["SELF_FUNCTION"], InvocationType="Event", Payload=json.dumps({"mode": "activity", "day": day, "hop": int(event.get("hop", 0)) + 1}).encode())
            r["reinvoked"] = True
        r["calls"] = c.calls
        return r
    return {"error": f"unknown mode {mode}"}
