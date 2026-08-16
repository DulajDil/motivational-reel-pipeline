import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_dynamodb as dynamodb,
  aws_ecr as ecr,
  aws_kms as kms,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sqs as sqs,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { resourceName, type DeploySettings } from './config.js';

export interface FoundationStackProps extends StackProps {
  settings: DeploySettings;
}

/**
 * Storage, state and shared plumbing.
 *
 * Security posture:
 *   - the assets bucket is private, blocks all public access, is encrypted with
 *     a customer-managed key, versioned, and enforces TLS,
 *   - the only route to an object from outside AWS is a short-lived pre-signed
 *     URL issued by the publisher role,
 *   - the Meta secret is created empty-by-template; the real token is written
 *     out of band (see docs/meta-onboarding.md) and never appears in this repo.
 */
export class FoundationStack extends Stack {
  public readonly assetsBucket: s3.Bucket;

  public readonly assetsKey: kms.Key;

  public readonly table: dynamodb.Table;

  public readonly metaSecret: secretsmanager.Secret;
  public readonly openAiSecret: secretsmanager.Secret;

  public readonly killSwitchParameter: ssm.StringParameter;

  public readonly rendererRepository: ecr.Repository;

  public readonly deadLetterQueue: sqs.Queue;

  public readonly alarmTopic: sns.Topic;

  public constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const { settings } = props;
    const isProd = settings.environment === 'prod';

    this.assetsKey = new kms.Key(this, 'AssetsKey', {
      alias: `alias/${resourceName(settings, 'assets')}`,
      description: 'Encrypts generated images, renders, manifests and music.',
      enableKeyRotation: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName: resourceName(settings, `assets-${this.account}`),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.assetsKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [
        {
          // Raw provider responses: useful for a few weeks of debugging only.
          id: 'raw-responses',
          prefix: 'raw/',
          expiration: Duration.days(30),
        },
        {
          id: 'source-images',
          prefix: 'images/',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
          ],
          expiration: Duration.days(90),
        },
        {
          id: 'finished-renders',
          prefix: 'renders/',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(90),
            },
          ],
          expiration: Duration.days(settings.retainFinalsDays),
        },
        {
          // Audit trail outlives the media it describes.
          id: 'audit-manifests',
          prefix: 'manifests/',
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(90),
            },
          ],
          expiration: Duration.days(settings.retainAuditDays),
        },
        {
          id: 'publish-receipts',
          prefix: 'receipts/',
          expiration: Duration.days(settings.retainAuditDays),
        },
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });

    /**
     * Single table. Key patterns and access patterns: docs/data-model.md.
     *   gsi1 - schedule by intended publish time
     *   gsi2 - recent content history for dedupe
     *   gsi3 - work queues (open reviews, retryable publishes, jobs by status)
     */
    this.table = new dynamodb.Table(this, 'CoreTable', {
      tableName: resourceName(settings, 'core'),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      deletionProtection: isProd,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1-schedule',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['jobId', 'platform', 'publishAt', 'publishDate', 'status'],
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi2-content-history',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['fingerprint', 'text', 'jobId', 'createdAt'],
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi3-status',
      partitionKey: { name: 'gsi3pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi3sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.metaSecret = new secretsmanager.Secret(this, 'MetaSecret', {
      secretName: resourceName(settings, 'meta'),
      description:
        'Meta Graph credentials. Shape: {pageAccessToken, instagramAccessToken?, appId?, appSecret?}. Populate out of band; never commit a real value.',
      generateSecretString: {
        // Creates a placeholder so the resource exists with the right shape. The
        // operator replaces the whole value during onboarding.
        secretStringTemplate: JSON.stringify({ appId: 'REPLACE_ME', appSecret: 'REPLACE_ME' }),
        generateStringKey: 'pageAccessToken',
        excludePunctuation: true,
        passwordLength: 40,
      },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    /*
     * OpenAI API key, used only when IMAGE_PROVIDER=openai. Kept separate from
     * the Meta secret so the two rotate independently and the generation role
     * can be granted this one without ever seeing a publishing credential.
     */
    this.openAiSecret = new secretsmanager.Secret(this, 'OpenAiSecret', {
      secretName: resourceName(settings, 'openai'),
      description:
        'OpenAI API key for image generation. Shape: {apiKey}. Populate out of band; never commit a real value.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'apiKey',
        excludePunctuation: true,
        passwordLength: 40,
      },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.killSwitchParameter = new ssm.StringParameter(this, 'KillSwitch', {
      parameterName: `/mrp/${settings.environment}/kill-switch`,
      stringValue: 'false',
      description:
        'Set to "true" to halt all scheduled publishing immediately. Assets are retained; no deploy required.',
      tier: ssm.ParameterTier.STANDARD,
    });

    this.rendererRepository = new ecr.Repository(this, 'RendererRepository', {
      repositoryName: resourceName(settings, 'renderer'),
      imageScanOnPush: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      emptyOnDelete: !isProd,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: resourceName(settings, 'dlq'),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: resourceName(settings, 'alarms'),
      displayName: 'Motivational Reel Pipeline alarms',
    });
  }
}
