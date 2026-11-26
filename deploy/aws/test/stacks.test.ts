import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AppStack, DnsStack } from '../lib/stacks.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const app = new cdk.App();
const env = { region: 'ap-southeast-2' };
const dns = new DnsStack(app, 'Dns', { env, zoneName: 'platewatch.civicmaps.com.au' });
const stack = new AppStack(app, 'App', { env, zone: dns.zone, domainName: 'platewatch.civicmaps.com.au', repoRoot, council: 'com', timeZone: 'Australia/Melbourne', hotAckSeconds: 60, radioEscalateSeconds: 0 });
const t = Template.fromStack(stack);

test('database: private, encrypted, backed up, protected', () => {
  t.hasResourceProperties('AWS::RDS::DBInstance', { Engine: 'postgres', PubliclyAccessible: false, StorageEncrypted: true, BackupRetentionPeriod: 7, DeletionProtection: true, DBInstanceClass: 'db.t4g.micro' });
});

test('no NAT gateway; HTTPS listener with HTTP redirected', () => {
  t.resourceCountIs('AWS::EC2::NatGateway', 0);
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Protocol: 'HTTPS', Port: 443 });
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Protocol: 'HTTP', Port: 80, DefaultActions: [Match.objectLike({ Type: 'redirect' })] });
  t.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'platewatch.civicmaps.com.au', ValidationMethod: 'DNS' });
});

test('server gets the database and tokens as secrets, never as plain environment', () => {
  const task = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0] as { Properties: { ContainerDefinitions: { Environment: { Name: string }[]; Secrets: { Name: string }[] }[] } };
  const c = task.Properties.ContainerDefinitions[0]!;
  assert.deepEqual(c.Secrets.map((s) => s.Name).sort(), ['PGDATABASE', 'PGHOST', 'PGPASSWORD', 'PGPORT', 'PGUSER', 'PLATEWATCH_CONSOLE_TOKEN', 'PLATEWATCH_DEVICE_TOKEN']);
  const plain = c.Environment.map((e) => e.Name);
  for (const s of ['PGPASSWORD', 'PLATEWATCH_DEVICE_TOKEN', 'PLATEWATCH_CONSOLE_TOKEN', 'DATABASE_URL']) assert.ok(!plain.includes(s), `${s} must not be plain`);
  assert.ok(plain.includes('PLATEWATCH_DB_CA_FILE'));
});

test('health check on /api/health; database reachable only from the service', () => {
  t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { HealthCheckPath: '/api/health' });
  t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { Description: 'PlateWatch server', SourceSecurityGroupId: Match.anyValue(), FromPort: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Database'), 'Endpoint.Port'] } });
});
