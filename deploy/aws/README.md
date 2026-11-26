---
title: PlateWatch backend on AWS (field testing)
status: Ready to deploy — synthesised and tested here; not yet deployed
region: ap-southeast-2 (Sydney)
domain: platewatch.civicmaps.com.au (delegated subdomain)
stacks: [PlateWatchDns, PlateWatchApp]
---

# PlateWatch backend on AWS

One origin serves everything: `https://platewatch.civicmaps.com.au/` (the PlateWatch PWA),
`/api/…` (handsets) and `/console/` (the CommandMAPS stand-in). See `docs/BACKEND.md`.

| Stack | Creates |
|---|---|
| `PlateWatchDns` | Route 53 public hosted zone `platewatch.civicmaps.com.au` |
| `PlateWatchApp` | VPC (2 AZs, public + isolated subnets, **no NAT gateway**); RDS PostgreSQL 16 `db.t4g.micro` (isolated subnets, encrypted, 7-day backups, deletion protection, snapshot on delete); ECS Fargate service (0.5 vCPU, 1 GB, 1 task) behind an HTTPS Application Load Balancer (ACM certificate, HTTP → HTTPS); device and console tokens generated in Secrets Manager; logs in CloudWatch (30 days) |

The server verifies the database's TLS certificate against the Amazon RDS CA bundle baked into
the image. Database credentials and tokens reach the container only as ECS secrets.

## What you need

- An **AWS account** with IAM credentials for the CLI (`aws sts get-caller-identity` works). An
  AWS *Builder ID* on its own is not an AWS account.
- Node.js 22 and **Docker running** (CDK builds the server image locally and pushes it to ECR).
- Access to the DNS for `civicmaps.com.au` — wherever its name servers point (Cloudflare or
  VentraIP). On 25/11/2026 public DNS answered from VentraIP's `ns1–3.nameserver.net.au`; if the
  domain was moved to Cloudflare, add the records there instead.

## Deploy

```bash
cd deploy/aws
npm ci
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/ap-southeast-2   # once per account/region

# 1. The DNS zone; note the four name servers it prints (NameServers output).
npx cdk deploy PlateWatchDns

# 2. At the DNS host of civicmaps.com.au, add four NS records:
#      name: platewatch   type: NS   value: <each name server>   (Cloudflare: DNS only)
#    Check:  nslookup -type=NS platewatch.civicmaps.com.au   → the four AWS name servers

# 3. Everything else (10–20 min: the certificate validates itself once step 2 is live).
npx cdk deploy PlateWatchApp
```

The outputs give the URL and the two commands that print the **device token** and the
**console token**.

## First use

1. Open `https://platewatch.civicmaps.com.au/console/` → console token → the roster is empty:
   create the first manager (team supervisor or compliance lead).
2. **Roster**: add dispatch, team supervisors, the compliance lead and every officer (officer
   number, team). Tick who is **on shift today** — it routes the soft Code 1.
3. Each handset: open `https://platewatch.civicmaps.com.au/` (install the PWA) or the APK →
   **Settings**: officer number; **Backend**: URL `https://platewatch.civicmaps.com.au`, the
   device token → **Test connection**.
4. Console → **Devices** → **Approve** each handset key (team supervisor or compliance lead).

## Settings

`cdk.json` context (or `-c key=value` on deploy):

| Key | Default | Meaning |
|---|---|---|
| `region` | `ap-southeast-2` | AWS region (`ap-southeast-4` is Melbourne) |
| `zoneName` | `platewatch.civicmaps.com.au` | The delegated subdomain |
| `council` | `com` | Council code the infringement numbers must name |
| `timeZone` | `Australia/Melbourne` | Council day for shifts |
| `hotAckSeconds` | `60` | Seconds to answer the hot-list pop-up before the soft Code 1 (BE-4) |
| `radioEscalateSeconds` | `0` | Auto-escalate to Code 1 with no radio response (0 = manual) |

## Update, inspect, remove

```bash
npx cdk diff PlateWatchApp       # what would change
npx cdk deploy PlateWatchApp     # rebuilds the image from this checkout and rolls the service
npm test                         # infrastructure assertions (no AWS access needed)
```

Logs: CloudWatch → log group containing `PlateWatchApp-Server`. Removal: the database has
deletion protection; turn it off in RDS first, then `npx cdk destroy --all` (a final snapshot is
kept). Rotate a token in Secrets Manager, then force a new deployment of the ECS service.

## Cost (rough guide, check the AWS Pricing Calculator)

Load balancer, one small Fargate task, `db.t4g.micro` with 20 GB, a Route 53 zone, three secrets
and logs: in the order of **US$50–70 a month** in Sydney with light field-test traffic. There is
deliberately no NAT gateway (the largest avoidable cost).

## Not covered

- No WAF, IP allow-listing of the console, or custom alarms — add before wider use.
- Console staff identity is chosen from the roster after the console token (development
  stand-in for CivicMAPS sign-in).
- Single task and single-AZ database: fine for field testing, not for production.
