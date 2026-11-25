/**
 * PlateWatch backend on AWS for field testing (deploy/aws/README.md).
 *
 * PlateWatchDns  Route 53 public zone for the delegated subdomain (e.g. platewatch.civicmaps.com.au).
 *                Its four name servers are added once as NS records at the DNS host of the parent
 *                domain (Cloudflare or VentraIP); certificates and records are then automatic.
 * PlateWatchApp  VPC with public and isolated subnets (no NAT gateway); PostgreSQL 16 on RDS in the
 *                isolated subnets (encrypted, 7-day backups, deletion protection, TLS verified by the
 *                server); the server container on ECS Fargate behind an HTTPS load balancer (ACM
 *                certificate, HTTP → HTTPS); device and console tokens generated in Secrets Manager.
 */
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface DnsStackProps extends cdk.StackProps {
  zoneName: string;
}

export class DnsStack extends cdk.Stack {
  readonly zone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);
    this.zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: props.zoneName,
      comment: 'PlateWatch field-test backend. Delegated from the parent domain with NS records.',
    });
    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(' ', this.zone.hostedZoneNameServers!),
      description: `Add one NS record per name server for "${props.zoneName}" at the DNS host of the parent domain.`,
    });
  }
}

export interface AppStackProps extends cdk.StackProps {
  zone: route53.IHostedZone;
  domainName: string;
  /** Repository root (the Docker build context: server/Dockerfile). */
  repoRoot: string;
  council: string;
  timeZone: string;
  hotAckSeconds: number;
  radioEscalateSeconds: number;
}

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // No NAT gateway (cost): tasks sit in public subnets with a public IP and accept traffic only
    // from the load balancer; the database is in isolated subnets with no route to the internet.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const db = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: rds.Credentials.fromGeneratedSecret('platewatch'),
      databaseName: 'platewatch',
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageEncrypted: true,
      publiclyAccessible: false,
      multiAz: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
    });

    const token = (name: string, description: string) =>
      new secrets.Secret(this, name, { description, generateSecretString: { passwordLength: 48, excludePunctuation: true } });
    const deviceToken = token('DeviceToken', 'PlateWatch device token (Settings → Backend on each handset).');
    const consoleToken = token('ConsoleToken', 'PlateWatch console token (CommandMAPS stand-in).');

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(props.zone),
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const dbSecret = db.secret!;

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Server', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      publicLoadBalancer: true,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      certificate,
      domainName: props.domainName,
      domainZone: props.zone,
      redirectHTTP: true,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(props.repoRoot, { file: 'server/Dockerfile', platform: Platform.LINUX_AMD64 }),
        containerPort: 8787,
        environment: {
          PORT: '8787',
          NODE_ENV: 'production',
          PLATEWATCH_COUNCIL: props.council,
          PLATEWATCH_TIMEZONE: props.timeZone,
          PLATEWATCH_HOT_ACK_SECONDS: String(props.hotAckSeconds),
          PLATEWATCH_RADIO_ESCALATE_SECONDS: String(props.radioEscalateSeconds),
          PLATEWATCH_CORS_ORIGINS: '*',
          // Verify the RDS certificate (CA bundle baked into the image).
          PLATEWATCH_DB_CA_FILE: '/app/rds-ca.pem',
        },
        secrets: {
          PGHOST: ecs.Secret.fromSecretsManager(dbSecret, 'host'),
          PGPORT: ecs.Secret.fromSecretsManager(dbSecret, 'port'),
          PGUSER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
          PGPASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
          PGDATABASE: ecs.Secret.fromSecretsManager(dbSecret, 'dbname'),
          PLATEWATCH_DEVICE_TOKEN: ecs.Secret.fromSecretsManager(deviceToken),
          PLATEWATCH_CONSOLE_TOKEN: ecs.Secret.fromSecretsManager(consoleToken),
        },
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'platewatch', logRetention: logs.RetentionDays.ONE_MONTH }),
      },
    });
    service.targetGroup.configureHealthCheck({ path: '/api/health', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30) });
    service.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '15');
    db.connections.allowDefaultPortFrom(service.service, 'PlateWatch server');

    const url = `https://${props.domainName}`;
    new cdk.CfnOutput(this, 'Url', { value: url, description: 'App (handsets), API and console at /console/' });
    new cdk.CfnOutput(this, 'ConsoleUrl', { value: `${url}/console/` });
    new cdk.CfnOutput(this, 'DeviceTokenCommand', { value: `aws secretsmanager get-secret-value --region ${this.region} --secret-id ${deviceToken.secretName} --query SecretString --output text` });
    new cdk.CfnOutput(this, 'ConsoleTokenCommand', { value: `aws secretsmanager get-secret-value --region ${this.region} --secret-id ${consoleToken.secretName} --query SecretString --output text` });
    new cdk.CfnOutput(this, 'LogGroupHint', { value: 'CloudWatch Logs → log groups containing "PlateWatchApp-Server"' });
  }
}
