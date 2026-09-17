"""Nightly Math Academy store refresh (AWS Lambda, python3.12, 900 s). Two modes, chosen by event["mode"]:
  snapshot  - bulk list + Timeback roster + match + write (store/snapshot_lib.run_snapshot)
  activity  - per-task engaged/productive time for every student active on each America/Chicago day from (last pulled day - 1)
              through yesterday (failsafe: a missed night is caught up, the overlap day is re-pulled and overwrites, never duplicates;
              capped at 14 days per run); event["day"] (+ "force") pulls one named day instead; resumable, re-invokes itself when the
              time budget runs out.
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

from zoneinfo import ZoneInfo
def yesterday_local():
    now_local = datetime.datetime.now(ZoneInfo("America/Chicago"))
    return (now_local.date() - datetime.timedelta(days=1)).isoformat()

def handler(event, context):
    event = event or {}
    mode = event.get("mode", "snapshot")
    time_left = (lambda: context.get_remaining_time_in_millis() / 1000) if context else (lambda: 10 ** 9)
    c = lib.Clients(creds(), log=print)
    if mode == "snapshot":
        snap = lib.run_snapshot(c, ddb, TABLE, time_left=time_left, lookup=not event.get("noLookup"), nightly=True, source=event.get("source", "manual"))
        deferred = snap["counts"]["tbUnmatchedByReason"].get("deferred: out of time tonight", 0)
        return {"mode": mode, "snapshotAt": snap["snapshotAt"], "counts": snap["counts"], "calls": c.calls, "deferredLookups": deferred}
    if mode == "activity":
        yesterday = yesterday_local()
        if event.get("day"):
            days = [event["day"]]; forces = {event["day"]: bool(event.get("force"))}
        else:
            # failsafe window: from the day before the last pulled day through yesterday; the overlap day is re-pulled
            # (late Timeback ingestion, late Math Academy tasks); rows are keyed by student+day+task so re-pulls overwrite, never duplicate
            meta = ddb.get_item(TableName=TABLE, Key={"pk": {"S": "meta"}, "sk": {"S": "snapshot"}}).get("Item") or {}
            last = (meta.get("activityLastDate") or {}).get("S")
            start = (datetime.date.fromisoformat(last) - datetime.timedelta(days=1)) if last else datetime.date.fromisoformat(yesterday)
            start = max(start, datetime.date.fromisoformat(yesterday) - datetime.timedelta(days=14))   # never more than two weeks in one go
            days = [(start + datetime.timedelta(days=i)).isoformat() for i in range((datetime.date.fromisoformat(yesterday) - start).days + 1)]
            forces = {d: (d <= (last or "")) for d in days}   # already-pulled days are overlap re-pulls
        results = []
        for i, day in enumerate(days):
            r = lib.run_activity(c, ddb, TABLE, day, tz_offset_hours=TZ_OFF, time_left=time_left, force=forces.get(day, False))
            results.append(r)
            if r.get("status") == "partial":
                if os.environ.get("SELF_FUNCTION") and int(event.get("hop", 0)) < 8:
                    lam.invoke(FunctionName=os.environ["SELF_FUNCTION"], InvocationType="Event", Payload=json.dumps({"mode": "activity", "source": event.get("source", "manual"), "hop": int(event.get("hop", 0)) + 1}).encode())
                    r["reinvoked"] = True
                break   # the re-invocation recomputes the window and resumes the partial day from its cursor
        # activityLastDate must end up at the newest fully pulled day, not the overlap day
        done_days = [x["day"] for x in results if x.get("status") == "done"]
        if done_days:
            ddb.update_item(TableName=TABLE, Key={"pk": {"S": "meta"}, "sk": {"S": "snapshot"}}, UpdateExpression="SET activityLastDate = :d", ExpressionAttributeValues={":d": {"S": max(done_days)}})
        return {"mode": mode, "window": days, "runs": results, "calls": c.calls}
    return {"error": f"unknown mode {mode}"}
