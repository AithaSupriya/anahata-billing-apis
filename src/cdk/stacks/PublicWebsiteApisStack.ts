import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { LambdaIntegration, AuthorizationType, Cors, type Resource } from 'aws-cdk-lib/aws-apigateway';
import { AnahataCommonStack, type CommonStackProps } from '@anahata/cdk-commons';

export interface PublicWebsiteApisStackProps extends CommonStackProps {
  /** The /apiv1/public resource (created by PublicApisStack) */
  publicResource: Resource;
}

/**
 * PublicWebsiteApisStack — Unauthenticated public endpoints for customer-facing
 * website integrations. Validated by x-api-key header.
 *
 * Routes:
 *   GET  /apiv1/public/{orgId}/products
 *   GET  /apiv1/public/{orgId}/plans
 *   GET  /apiv1/public/{orgId}/plans/{planId}
 *   POST /apiv1/public/{orgId}/subscribe
 */
export class PublicWebsiteApisStack extends AnahataCommonStack {
  constructor(scope: Construct, id: string, props: PublicWebsiteApisStackProps) {
    super(scope, id, props);

    // Import existing tables
    const productsTable = dynamodb.Table.fromTableName(this, 'ProductsTable', 'AnahataBillingProducts');
    const plansTable = dynamodb.Table.fromTableName(this, 'PlansTable', 'AnahataBillingPricingPlans');
    const customersTable = dynamodb.Table.fromTableName(this, 'CustomersTable', 'AnahataBillingCustomers');
    const subscriptionsTable = dynamodb.Table.fromTableName(this, 'SubscriptionsTable', 'AnahataBillingSubscriptions');
    const apiKeysTable = dynamodb.Table.fromTableName(this, 'ApiKeysTable', 'AnahataBillingApiKeys');

    // Lambda execution role
    const lambdaRole = new iam.Role(this, 'PublicWebsiteApisRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: `AnahataBillingPublicWebsiteApisRole-${props.env.stage}`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Read access
    productsTable.grantReadData(lambdaRole);
    plansTable.grantReadData(lambdaRole);
    apiKeysTable.grantReadData(lambdaRole);

    // Read + Write access (for creating customers and subscriptions)
    customersTable.grantReadWriteData(lambdaRole);
    subscriptionsTable.grantReadWriteData(lambdaRole);

    // Grant GSI query access
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/AnahataBillingApiKeys/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/AnahataBillingCustomers/index/*`,
      ],
    }));

    // Lambda function
    const publicWebsiteApisFn = new lambda.Function(this, 'PublicWebsiteApisLambda', {
      functionName: 'AnahataBillingPublicWebsiteApisLambda',
      code: lambda.Code.fromAsset('dist/lambda'),
      handler: 'public-website-apis.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      role: lambdaRole,
      environment: {
        PRODUCTS_TABLE_NAME: 'AnahataBillingProducts',
        PLANS_TABLE_NAME: 'AnahataBillingPricingPlans',
        CUSTOMERS_TABLE_NAME: 'AnahataBillingCustomers',
        SUBSCRIPTIONS_TABLE_NAME: 'AnahataBillingSubscriptions',
        API_KEYS_TABLE_NAME: 'AnahataBillingApiKeys',
      },
    });

    publicWebsiteApisFn.addPermission('ApiGwInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    const integration = new LambdaIntegration(publicWebsiteApisFn);

    // Add routes under /apiv1/public/{orgId}/...
    // CORS is handled by the parent API Gateway's defaultCorsPreflightOptions (Allow-Origin: *)
    const orgResource = props.publicResource.addResource('{orgId}');

    // GET /apiv1/public/{orgId}/products
    const productsResource = orgResource.addResource('products');
    productsResource.addMethod('GET', integration, { authorizationType: AuthorizationType.NONE });

    // GET /apiv1/public/{orgId}/plans
    const plansResource = orgResource.addResource('plans');
    plansResource.addMethod('GET', integration, { authorizationType: AuthorizationType.NONE });

    // GET /apiv1/public/{orgId}/plans/{planId}
    const planDetailResource = plansResource.addResource('{planId}');
    planDetailResource.addMethod('GET', integration, { authorizationType: AuthorizationType.NONE });

    // POST /apiv1/public/{orgId}/subscribe
    const subscribeResource = orgResource.addResource('subscribe');
    subscribeResource.addMethod('POST', integration, { authorizationType: AuthorizationType.NONE });
  }
}
