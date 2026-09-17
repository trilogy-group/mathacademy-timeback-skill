#!/usr/bin/env python3
"""Health alerts for the store: an SNS email topic + three CloudWatch alarms. Idempotent.

  py -3 lambda/nightly/alarms.py <email>        # create/refresh topic, subscription and alarms
  py -3 lambda/nightly/alarms.py --check        # state of the subscription and alarms

Alarms (all notify the topic on ALARM and on return to OK):
  mathacademy-timeback-nightly-errors    any failed run of the nightly function (Lambda Errors >= 1 in 5 min)
  mathacademy-timeback-nightly-missed    no invocation of the nightly function in a whole UTC day (schedule broken)
  mathacademy-timeback-front-errors      the front (docs + store routes) throwing errors (>= 3 in 5 min)
The owner confirms the subscription once by clicking the link in AWS's confirmation email."""
import sys, boto3
NIGHTLY, FRONT, TOPIC = "mathacademy-timeback-nightly", "mathacademy-timeback-skill", "mathacademy-timeback-alerts"
s = boto3.Session(profile_name="ruchibaid", region_name="us-east-1"); sns, cw = s.client("sns"), s.client("cloudwatch")
TAGS = [{"Key": "project", "Value": "mathacademy-timeback-skill"}, {"Key": "owner", "Value": "ruchi.baid"}]
topic = sns.create_topic(Name=TOPIC, Tags=TAGS)["TopicArn"]
if len(sys.argv) > 1 and sys.argv[1] == "--check":
    for sub in sns.list_subscriptions_by_topic(TopicArn=topic)["Subscriptions"]: print("subscription:", sub["Protocol"], "confirmed" if sub["SubscriptionArn"] != "PendingConfirmation" else "PENDING confirmation")
    for a in cw.describe_alarms(AlarmNamePrefix="mathacademy-timeback-")["MetricAlarms"]: print("alarm:", a["AlarmName"], a["StateValue"], "|", a.get("StateReason", "")[:80])
    sys.exit(0)
email = sys.argv[1] if len(sys.argv) > 1 else sys.exit("give the email to notify")
if not any(x["Endpoint"] == email for x in sns.list_subscriptions_by_topic(TopicArn=topic)["Subscriptions"]):
    sns.subscribe(TopicArn=topic, Protocol="email", Endpoint=email); print("subscription requested; confirm it from the AWS email")
else: print("subscription already present")
def alarm(name, fn, metric, threshold, op, period, missing, desc):
    cw.put_metric_alarm(AlarmName=name, AlarmDescription=desc, Namespace="AWS/Lambda", MetricName=metric, Dimensions=[{"Name": "FunctionName", "Value": fn}],
                        Statistic="Sum", Period=period, EvaluationPeriods=1, Threshold=threshold, ComparisonOperator=op, TreatMissingData=missing,
                        AlarmActions=[topic], OKActions=[topic], Tags=TAGS); print("alarm:", name)
alarm(f"{NIGHTLY}-errors", NIGHTLY, "Errors", 1, "GreaterThanOrEqualToThreshold", 300, "notBreaching", "The Math Academy store's nightly snapshot or activity pull threw an error. Check CloudWatch logs /aws/lambda/mathacademy-timeback-nightly and GET /store (stale, history, lastActivityRun).")
alarm(f"{NIGHTLY}-missed", NIGHTLY, "Invocations", 1, "LessThanThreshold", 86400, "breaching", "The Math Academy store's nightly function was not invoked at all in a whole UTC day: the EventBridge schedules are off or broken. Check `py -3 lambda/nightly/deploy.py check`.")
alarm(f"{FRONT}-errors", FRONT, "Errors", 3, "GreaterThanOrEqualToThreshold", 300, "notBreaching", "The mathacademy_timeback front (documents + store routes) is throwing errors. Check CloudWatch logs /aws/lambda/mathacademy-timeback-skill.")
print("topic:", topic)
