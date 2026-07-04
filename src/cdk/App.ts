#!/usr/bin/env node
/**
 * Billing Service APIs — CDK Application Entry Point
 *
 * Creates a CodePipeline that deploys all billing service stacks to sandbox and prod.
 * Generated stacks are imported from @anahata/billing-model (copied during build).
 */
import { App } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  AnahataCommonStack,
  AnahataStage,
  CodePipelineStack,
  ENV_SANDBOX,
  ENV_PROD,
  SANDBOX_WILDCARD_CERT_ARN,
  PROD_WILDCARD_CERT_ARN,
  type AnahataEnv,
} from '@anahata/cdk-commons';

// ── CDK Stacks ──
import { ServiceApiGatewayStack } from './stacks/ServiceApiGatewayStack.js';
import { DnsStack } from './stacks/DnsStack.js';
import { PublicApisStack } from './stacks/PublicApisStack.js';
import { CustomLambdasStack } from './stacks/CustomLambdasStack.js';
import { PublicWebsiteApisStack } from './stacks/PublicWebsiteApisStack.js';

// ── Generated Stacks (copied from anahata-billing-model during build) ──
import { AikoraOrganizationStack } from '../generated/cdk/AikoraOrganizationStack.js';
import { AikoraUserStack } from '../generated/cdk/AikoraUserStack.js';
import { AikoraAccessRoleStack } from '../generated/cdk/AikoraAccessRoleStack.js';
import { AikoraInvitationStack } from '../generated/cdk/AikoraInvitationStack.js';
import { AikoraProductStack } from '../generated/cdk/AikoraProductStack.js';
import { AikoraPricingPlanStack } from '../generated/cdk/AikoraPricingPlanStack.js';
import { AikoraCustomerStack } from '../generated/cdk/AikoraCustomerStack.js';
import { AikoraSubscriptionStack } from '../generated/cdk/AikoraSubscriptionStack.js';
import { AikoraApiKeyStack } from '../generated/cdk/AikoraApiKeyStack.js';

// ── Environment-specific Cognito User Pool IDs ──
const COGNITO_USER_POOL_IDS: Record<string, string> = {
  [AnahataStage.SANDBOX]: 'us-east-2_utDR1Yzo8',
  [AnahataStage.PROD]: 'us-east-2_y58HO9kRD',
  [AnahataStage.DEV]: 'us-east-2_utDR1Yzo8',
  [AnahataStage.GAMMA]: 'us-east-2_utDR1Yzo8',
};

// ── Cognito Client IDs per environment ──
// These are the app clients allowed to authenticate against the billing APIs.
const COGNITO_CLIENT_IDS: Record<string, string> = {
  [AnahataStage.SANDBOX]: '7psa52a6jaj4j4jgsbpibbvchm,a4nm2j561cl2fo7nhiohu0dki',
  [AnahataStage.PROD]: '7psa52a6jaj4j4jgsbpibbvchm',
  [AnahataStage.DEV]: '7psa52a6jaj4j4jgsbpibbvchm,a4nm2j561cl2fo7nhiohu0dki',
  [AnahataStage.GAMMA]: '7psa52a6jaj4j4jgsbpibbvchm',
};

// ── Admin users who bypass authorization checks ──
const ADMIN_USERS: Record<string, string> = {
  [AnahataStage.SANDBOX]: 'sgannu.e@gmail.com,yaswanthkrishna.nallapati@gmail.com,info@anahata.ai,a4nm2j561cl2fo7nhiohu0dki',
  [AnahataStage.PROD]: 'sgannu.e@gmail.com,info@anahata.ai',
  [AnahataStage.DEV]: 'sgannu.e@gmail.com,a4nm2j561cl2fo7nhiohu0dki',
  [AnahataStage.GAMMA]: 'sgannu.e@gmail.com',
};

// ── BuildSpec for CodePipeline synth step ──
const buildSpecObject = {
  version: '0.2',
  phases: {
    install: {
      commands: [
        'echo "Configuring CodeArtifact authentication..."',
        'export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token --domain anahata --domain-owner 689327566109 --region us-east-2 --query authorizationToken --output text)',
        'echo "Creating .npmrc with authentication..."',
        'printf "registry=https://registry.npmjs.org/\\n" > .npmrc',
        'printf "@anahata:registry=https://anahata-689327566109.d.codeartifact.us-east-2.amazonaws.com/npm/anahata-artifacts/\\n" >> .npmrc',
        'printf "//anahata-689327566109.d.codeartifact.us-east-2.amazonaws.com/npm/anahata-artifacts/:_authToken=%s\\n" "$CODEARTIFACT_AUTH_TOKEN" >> .npmrc',
        'printf "//anahata-689327566109.d.codeartifact.us-east-2.amazonaws.com/npm/anahata-artifacts/:always-auth=true\\n" >> .npmrc',
        'echo "Generated .npmrc (token redacted):"',
        'cat .npmrc | sed "s/:_authToken=.*/:_authToken=***REDACTED***/g"',
        'echo "Verifying CodeArtifact access..."',
        'npm view @anahata/cdk-commons versions || echo "Package not found or auth failed"',
        'echo "Installing dependencies..."',
        'npm install',
      ],
    },
    build: {
      commands: ['npm run build', 'npx cdk synth'],
    },
  },
};

// ─── Synthesize Function ───
// Creates all stacks for a given deployment environment.
const synthasize = (scope: Construct, env: AnahataEnv): AnahataCommonStack[] => {
  const cognitoUserPoolId = COGNITO_USER_POOL_IDS[env.stage];

  // ── DNS Stack ──
  const dnsStack = new DnsStack(scope, `AnahataBillingDnsStack-${env.stackSuffix()}`, {
    stackName: `AnahataBillingDnsStack-${env.stackSuffix()}`,
    env,
  });

  // ── API Gateway (shared) ──
  const apiGatewayStack = new ServiceApiGatewayStack(scope, `AnahataBillingApiGatewayStack-${env.stackSuffix()}`, {
    stackName: `AnahataBillingApiGatewayStack-${env.stackSuffix()}`,
    env,
    hostedZone: dnsStack.hostedZone,
    certificateArn: env.stage === AnahataStage.PROD ? PROD_WILDCARD_CERT_ARN : SANDBOX_WILDCARD_CERT_ARN,
    domainName: dnsStack.zoneName,
    cognitoUserPoolId: cognitoUserPoolId,
    cognitoClientIds: COGNITO_CLIENT_IDS[env.stage] || COGNITO_CLIENT_IDS[AnahataStage.SANDBOX],
    adminUsers: ADMIN_USERS[env.stage] || '',
  });

  // ── Shared API IDs for decoupled stacks (import mode) ──
  const restApiId = apiGatewayStack.restApi.restApiId;
  const parentResourceId = apiGatewayStack.apiResource.resourceId;
  const authorizerId = apiGatewayStack.authorizer?.authorizerId!;

  // Common props for all org-scoped resource stacks
  const apiProps = (extra?: Record<string, unknown>) => ({
    restApiId,
    parentResourceId,
    authorizerId,
    ...extra,
  });

  // ── Custom Lambdas (must deploy BEFORE generated stacks that reference them) ──
  const customLambdasStack = new CustomLambdasStack(scope, `AnahataBillingCustomLambdasStack-${env.stackSuffix()}`, {
    stackName: `AnahataBillingCustomLambdasStack-${env.stackSuffix()}`,
    env,
    cognitoUserPoolId,
  });

  // ── Generated Resource Stacks ──

  // Organization stack mounts at /apiv1/orgs (v1Resource, not {orgId})
  const organizationStack = new AikoraOrganizationStack(scope, `AnahataOrganizationStack-${env.stackSuffix()}`, {
    stackName: `AnahataOrganizationStack-${env.stackSuffix()}`,
    env,
    apiResource: apiGatewayStack.v1Resource,
    authorizer: apiGatewayStack.authorizer!,
  });

  const userStack = new AikoraUserStack(scope, `AnahataUserStack-${env.stackSuffix()}`, {
    stackName: `AnahataUserStack-${env.stackSuffix()}`,
    env,
    ...apiProps(),
  });

  const accessRoleStack = new AikoraAccessRoleStack(scope, `AnahataAccessRoleStack-${env.stackSuffix()}`, {
    stackName: `AnahataAccessRoleStack-${env.stackSuffix()}`,
    env,
    ...apiProps(),
  });

  const invitationStack = new AikoraInvitationStack(scope, `AnahataInvitationStack-${env.stackSuffix()}`, {
    stackName: `AnahataInvitationStack-${env.stackSuffix()}`,
    env,
    ...apiProps(),
  });

  // ── Phase 2: Product & Plan stacks ──
  const productStack = new AikoraProductStack(scope, `AnahataProductStack-${env.stackSuffix()}`, {
    stackName: `AnahataProductStack-${env.stackSuffix()}`,
    env,
    ...apiProps(),
  });

  const pricingPlanStack = new AikoraPricingPlanStack(scope, `AnahataPricingPlanStack-${env.stackSuffix()}`, {
    stackName: `AnahataPricingPlanStack-${env.stackSuffix()}`,
    env,
    ...apiProps(),
  });

  // ── Phase 3: Customer & Subscription stacks ──
  const customerStack = new AikoraCustomerStack(scope, `AnahataCustomerStack-${env.stackSuffix()}`, {
    stackName: `AnahataCustomerStack-${env.stackSuffix()}`,
    env,
    ...apiProps(),
  });

  const subscriptionStack = new AikoraSubscriptionStack(scope, `AnahataSubscriptionStack-${env.stackSuffix()}`, {
    stackName: `AnahataSubscriptionStack-${env.stackSuffix()}`,
    env,
    ...apiProps(),
  });

  // Subscription stack depends on custom lambdas (subscription lifecycle handler)
  subscriptionStack.node.addDependency(customLambdasStack);

  // ── Phase 4: ApiKey stack ──
  const apiKeyStack = new AikoraApiKeyStack(scope, `AnahataApiKeyStack-${env.stackSuffix()}`, {
    stackName: `AnahataApiKeyStack-${env.stackSuffix()}`,
    env,
    ...apiProps(),
  });

  // ── Public APIs (unauthenticated) ──
  const publicApisStack = new PublicApisStack(scope, `AnahataBillingPublicApisStack-${env.stackSuffix()}`, {
    stackName: `AnahataBillingPublicApisStack-${env.stackSuffix()}`,
    env,
    v1Resource: apiGatewayStack.v1Resource,
    cognitoUserPoolId,
  });

  // ── Phase 4: Public Website APIs (unauthenticated, x-api-key validated) ──
  const publicWebsiteApisStack = new PublicWebsiteApisStack(scope, `AnahataBillingPublicWebsiteApisStack-${env.stackSuffix()}`, {
    stackName: `AnahataBillingPublicWebsiteApisStack-${env.stackSuffix()}`,
    env,
    publicResource: publicApisStack.publicResource,
  });

  // Public website APIs depend on PublicApisStack (needs the /public resource)
  publicWebsiteApisStack.node.addDependency(publicApisStack);

  // Ensure custom lambdas are deployed before generated stacks that reference them
  organizationStack.node.addDependency(customLambdasStack);
  invitationStack.node.addDependency(customLambdasStack);

  return [
    dnsStack,
    apiGatewayStack,
    customLambdasStack,
    organizationStack,
    userStack,
    accessRoleStack,
    invitationStack,
    productStack,
    pricingPlanStack,
    customerStack,
    subscriptionStack,
    apiKeyStack,
    publicApisStack,
    publicWebsiteApisStack,
  ];
};

// ─── Create Pipeline ───
const app = new App();

new CodePipelineStack(app, 'AnahataBillingServiceApisPipeline', {
  env: ENV_SANDBOX,
  repositoryName: 'anahata-ai/anahata-billing-apis',
  deploymentEnvs: [ENV_SANDBOX, ENV_PROD],
  synthasize: synthasize as any,
  buildSpecObject,
});

app.synth();
