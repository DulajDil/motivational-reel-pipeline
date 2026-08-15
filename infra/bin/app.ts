#!/usr/bin/env node
import { App, Aspects, Tags } from 'aws-cdk-lib';

import { loadDeploySettings } from '../lib/config.js';
import { ComputeStack } from '../lib/compute-stack.js';
import { FoundationStack } from '../lib/foundation-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';
import { WorkflowStack } from '../lib/workflow-stack.js';

const app = new App();
const settings = loadDeploySettings(app);

const env = { account: settings.account, region: settings.region };
const prefix = `Mrp-${settings.environment}`;

const foundation = new FoundationStack(app, `${prefix}-Foundation`, { env, settings });

const compute = new ComputeStack(app, `${prefix}-Compute`, { env, settings, foundation });
compute.addDependency(foundation);

const workflow = new WorkflowStack(app, `${prefix}-Workflow`, {
  env,
  settings,
  foundation,
  compute,
});
workflow.addDependency(compute);

const observability = new ObservabilityStack(app, `${prefix}-Observability`, {
  env,
  settings,
  foundation,
  compute,
  workflow,
});
observability.addDependency(workflow);

Tags.of(app).add('project', 'motivational-reel-pipeline');
Tags.of(app).add('environment', settings.environment);
Tags.of(app).add('managed-by', 'cdk');

// Nothing here mutates the app; kept as the hook for future policy aspects
// (e.g. cdk-nag) so the wiring exists before it is needed.
Aspects.of(app);

app.synth();
