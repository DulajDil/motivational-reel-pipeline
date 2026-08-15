import {
  Duration,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { resourceName, type DeploySettings } from './config.js';

export interface NodeFunctionOptions {
  settings: DeploySettings;
  entry: string;
  role: iam.IRole;
  environment: Record<string, string>;
  handler?: string;
  timeout?: Duration;
  memorySize?: number;
  reservedConcurrentExecutions?: number;
}

/**
 * Shared Lambda factory.
 *
 * Lives outside the stacks so more than one stack can create functions without
 * introducing a cross-stack reference cycle.
 */
export const createNodeFunction = (
  scope: Construct,
  id: string,
  options: NodeFunctionOptions,
): nodejs.NodejsFunction =>
  new nodejs.NodejsFunction(scope, id, {
    functionName: resourceName(
      options.settings,
      id.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
    ),
    entry: options.entry,
    handler: options.handler ?? 'handler',
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    role: options.role,
    timeout: options.timeout ?? Duration.seconds(30),
    memorySize: options.memorySize ?? 512,
    reservedConcurrentExecutions: options.reservedConcurrentExecutions,
    logRetention: logs.RetentionDays.ONE_MONTH,
    environment: { ...options.environment, NODE_OPTIONS: '--enable-source-maps' },
    bundling: {
      format: nodejs.OutputFormat.ESM,
      target: 'node22',
      minify: true,
      sourceMap: true,
      // Bundle the AWS SDK rather than relying on the runtime's copy, so a
      // runtime update cannot silently change client behaviour.
      externalModules: [],
      banner: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
    },
  });

export const lambdaRole = (
  scope: Construct,
  id: string,
  settings: DeploySettings,
  purpose: string,
): iam.Role => {
  const role = new iam.Role(scope, id, {
    roleName: resourceName(settings, `${purpose}-role`),
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: `Least-privilege role for the ${purpose} functions.`,
  });
  role.addManagedPolicy(
    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
  );
  return role;
};
