#!/usr/bin/env python3
"""Load one snapshot file (from pull_snapshot.py) into the skill's store table and grant the Lambda role read access.

  py -3 store/load_snapshot.py <snapshot.json> [--profile ruchibaid]

Table mathacademy-timeback-skill-store (on-demand, pk S / sk S), created if missing:
  pk 'student'      sk <Timeback user sourcedId>  : ma (JSON), matchedBy, courseAgreementAtSnapshot, seats (JSON), isTestUser, snapshotAt
  pk 'tb_unmatched' sk <Timeback user sourcedId>  : reason, seats (JSON), isTestUser, snapshotAt
  pk 'ma_unmatched' sk <Math Academy student id>  : ma (JSON), snapshotAt            (never served row by row; counted in /store)
  pk 'meta'         sk 'snapshot'                 : snapshotAt, apiVersion, calls (JSON), counts (JSON)
Every load replaces the whole snapshot (rows from an older snapshot are deleted first)."""
import argparse, json, pathlib, sys, time
import boto3, botocore

ap = argparse.ArgumentParser(); ap.add_argument("snapshot"); ap.add_argument("--profile", default="ruchibaid")
a = ap.parse_args()
TABLE = "mathacademy-timeback-skill-store"; ROLE = "team-dev-mathacademy-skill-lambda"
TAGS = [{"Key": "project", "Value": "mathacademy-timeback-skill"}, {"Key": "owner", "Value": "ruchi.baid"}, {"Key": "purpose", "Value": "math academy snapshot store"}]
s = boto3.Session(profile_name=a.profile, region_name="us-east-1"); ddb = s.client("dynamodb"); iam = s.client("iam")

try: ddb.describe_table(TableName=TABLE)
except botocore.exceptions.ClientError:
    ddb.create_table(TableName=TABLE, BillingMode="PAY_PER_REQUEST", Tags=TAGS,
                     AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
                     KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}])
    ddb.get_waiter("table_exists").wait(TableName=TABLE); print("table created")
arn = ddb.describe_table(TableName=TABLE)["Table"]["TableArn"]
iam.put_role_policy(RoleName=ROLE, PolicyName="store-table", PolicyDocument=json.dumps({
    "Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:Query"], "Resource": arn}]}))
print("role read policy on", TABLE)

snap = json.loads(pathlib.Path(a.snapshot).read_text(encoding="utf-8"))
S = lambda v: {"S": str(v)}
# wipe old rows
old, key = [], None
for pk in ("student", "tb_unmatched", "ma_unmatched"):
    key = None
    while True:
        r = ddb.query(TableName=TABLE, KeyConditionExpression="pk = :p", ExpressionAttributeValues={":p": S(pk)}, ProjectionExpression="pk, sk", **({"ExclusiveStartKey": key} if key else {}))
        old.extend(r["Items"]); key = r.get("LastEvaluatedKey")
        if not key: break
def batch(items):
    for i in range(0, len(items), 25):
        chunk = items[i:i + 25]
        for _ in range(8):
            r = ddb.batch_write_item(RequestItems={TABLE: chunk}); chunk = r.get("UnprocessedItems", {}).get(TABLE) or []
            if not chunk: break
            time.sleep(1)
batch([{"DeleteRequest": {"Key": {"pk": it["pk"], "sk": it["sk"]}}} for it in old]); print("old rows removed:", len(old))

at = snap["snapshotAt"]; items = []
for st in snap["students"]:
    items.append({"PutRequest": {"Item": {"pk": S("student"), "sk": S(st["sourcedId"]), "ma": S(json.dumps(st["mathAcademy"], ensure_ascii=False)),
                                          "matchedBy": S(st["matchedBy"]), "courseAgreementAtSnapshot": S(st.get("courseAgreementAtSnapshot", "")),
                                          "seats": S(json.dumps(st["seats"])), "isTestUser": {"BOOL": bool(st["isTestUser"])}, "snapshotAt": S(at)}}})
for u in snap["tb_unmatched"]:
    items.append({"PutRequest": {"Item": {"pk": S("tb_unmatched"), "sk": S(u["sourcedId"]), "reason": S(u["reason"]), "seats": S(json.dumps(u["seats"])),
                                          "isTestUser": {"BOOL": bool(u["isTestUser"])}, "snapshotAt": S(at)}}})
for m in snap["ma_unmatched"]:
    items.append({"PutRequest": {"Item": {"pk": S("ma_unmatched"), "sk": S(m.get("id")), "ma": S(json.dumps(m, ensure_ascii=False)), "snapshotAt": S(at)}}})
batch(items)
ddb.put_item(TableName=TABLE, Item={"pk": S("meta"), "sk": S("snapshot"), "snapshotAt": S(at), "apiVersion": S(snap["apiVersion"]),
                                    "calls": S(json.dumps(snap["calls"])), "counts": S(json.dumps(snap["counts"]))})
print(f"loaded: {len(snap['students'])} students, {len(snap['tb_unmatched'])} tb_unmatched, {len(snap['ma_unmatched'])} ma_unmatched; snapshotAt {at}")
