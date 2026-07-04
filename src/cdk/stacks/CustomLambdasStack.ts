import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { AnahataCommonStack, type CommonStackProps } from '@anahata/cdk-commons';

export interface CustomLambdasStackProps extends CommonStackProps {
  cognitoUserPoolId: string;
}

/**
 * CustomLambdasStack — Creates the custom Lambda functions referenced by
 * @customLambda traits in the Smithy model. These must be deployed BEFORE
 * the generated resource stacks that import them by name.
 */
export class CustomLambdasStack extends AnahataCommonStack {
  public readonly orgCreationLambda: lambda.Function;
  public readonly invitationLambda: lambda.Function;
  public readonly subscriptionLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: CustomLambdasStackProps) {
    super(scope, id, props);

    // Import DynamoDB tables (names must match what the generated stacks create)
    const orgsTable = dynamodb.Table.fromTableName(this, 'OrgsTable', 'BillingOrganizations');
    const usersTable = dynamodb.Table.fromTableName(this, 'UsersTable', 'BillingUsers');
    const rolesTable = dynamodb.Table.fromTableName(this, 'RolesTable', 'BillingAccessRoles');
    const invitationsTable = dynamodb.Table.fromTableName(this, 'InvitationsTable', 'BillingInvitations');
    const customersTable = dynamodb.Table.fromTableName(this, 'CustomersTable', 'AnahataBillingCustomers');
    const subscriptionsTable = dynamodb.Table.fromTableName(this, 'SubscriptionsTable', 'AnahataBillingSubscriptions');
    const plansTable = dynamodb.Table.fromTableName(this, 'PlansTable', 'AnahataBillingPricingPlans');

    // Shared IAM role for custom Lambdas
    const lambdaRole = new iam.Role(this, 'CustomLambdasRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    orgsTable.grantReadWriteData(lambdaRole);
    usersTable.grantReadWriteData(lambdaRole);
    rolesTable.grantReadWriteData(lambdaRole);
    invitationsTable.grantReadWriteData(lambdaRole);
    customersTable.grantReadWriteData(lambdaRole);
    subscriptionsTable.grantReadWriteData(lambdaRole);
    plansTable.grantReadData(lambdaRole);

    // Grant access to DynamoDB GSIs (grantReadWriteData only covers the base table)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query', 'dynamodb:Scan'],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/Billing*/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/AnahataBilling*/index/*`,
      ],
    }));

    // Cognito permissions for user creation
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminGetUser',
      ],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.cognitoUserPoolId}`],
    }));

    // API Gateway invoke permission
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: ['*'],
    }));

    // SES permission for sending invitation emails
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    const sharedEnv = {
      ORGANIZATIONS_TABLE_NAME: 'BillingOrganizations',
      USERS_TABLE_NAME: 'BillingUsers',
      ACCESS_ROLES_TABLE_NAME: 'BillingAccessRoles',
      INVITATIONS_TABLE_NAME: 'BillingInvitations',
      COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
    };

    // ── BillingCustomOrgCreationLambda ──
    // Handles: POST /apiv1/orgs, DELETE /apiv1/orgs/{orgId}, GET /apiv1/orgs/list
    this.orgCreationLambda = new lambda.Function(this, 'BillingCustomOrgCreationLambda', {
      functionName: 'BillingCustomOrgCreationLambda',
      code: lambda.Code.fromAsset('dist/lambda'),
      handler: 'custom-org-creation.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      role: lambdaRole,
      environment: sharedEnv,
    });

    this.orgCreationLambda.addPermission('ApiGwInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    // ── List Orgs Lambda (same function name referenced in @customLambda) ──
    // The Smithy model uses the same lambdaName for create, delete, and list
    // so only one function is needed. The handler routes by HTTP method.

    // ── BillingCustomInvitationLambda ──
    this.invitationLambda = new lambda.Function(this, 'BillingCustomInvitationLambda', {
      functionName: 'BillingCustomInvitationLambda',
      code: lambda.Code.fromAsset('dist/lambda'),
      handler: 'custom-invitation.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      role: lambdaRole,
      environment: {
        ...sharedEnv,
        FROM_EMAIL: 'supriya.a.visys@gmail.com',
        FRONTEND_URL: props.env.stage === 'prod'
          ? 'https://billing.anahata.ai'
          : 'http://localhost:5173',
      },
    });

    this.invitationLambda.addPermission('ApiGwInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    // ── AnahataBillingSubscriptionLambda ──
    // Handles: POST (create), PUT (upgrade/downgrade), DELETE (cancel)
    this.subscriptionLambda = new lambda.Function(this, 'AnahataBillingSubscriptionLambda', {
      functionName: 'AnahataBillingSubscriptionLambda',
      code: lambda.Code.fromAsset('dist/lambda'),
      handler: 'subscription-lifecycle.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      role: lambdaRole,
      environment: {
        ...sharedEnv,
        SUBSCRIPTIONS_TABLE_NAME: 'AnahataBillingSubscriptions',
        CUSTOMERS_TABLE_NAME: 'AnahataBillingCustomers',
        PLANS_TABLE_NAME: 'AnahataBillingPricingPlans',
      },
    });

    this.subscriptionLambda.addPermission('ApiGwInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
  }
}
