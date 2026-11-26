import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { AppStack, DnsStack } from '../lib/stacks.ts';

const app = new cdk.App();
const ctx = (k: string) => app.node.tryGetContext(k);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: (ctx('region') as string) ?? 'ap-southeast-2' };
const zoneName = ctx('zoneName') as string;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const dns = new DnsStack(app, 'PlateWatchDns', { env, zoneName, description: `PlateWatch: DNS zone for ${zoneName}` });
new AppStack(app, 'PlateWatchApp', {
  env,
  description: 'PlateWatch field-test backend: Fargate, RDS PostgreSQL, HTTPS load balancer',
  zone: dns.zone,
  domainName: zoneName,
  repoRoot,
  council: String(ctx('council') ?? 'com'),
  timeZone: String(ctx('timeZone') ?? 'Australia/Melbourne'),
  hotAckSeconds: Number(ctx('hotAckSeconds') ?? 60),
  radioEscalateSeconds: Number(ctx('radioEscalateSeconds') ?? 0),
});
cdk.Tags.of(app).add('Project', 'PlateWatch');
cdk.Tags.of(app).add('Environment', 'field-test');
