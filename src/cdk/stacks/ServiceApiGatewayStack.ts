import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import {
  RestApi, Cors, MethodLoggingLevel, Model,
  MockIntegration, DomainName, AuthorizationType,
  CfnAuthorizer, GatewayResponse, ResponseType,
  Resource, LogGroupLogDestination, AccessLogFormat,
  type IAuthorizer,
} from 'aws-cdk-lib/aws-apigateway';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { AnahataCommonStack, AnahataStage, type CommonStackProps } from '@anahata/cdk-commons';

export interface ServiceApiGatewayStackProps extends CommonStackProps {
  hostedZone?: IHostedZone;
  certificateArn?: string;
  domainName?: string;
  cognitoUserPoolId: string;
  /** Comma-separated list of allowed Cognito client IDs */
  cognitoClientIds: string;
  /** Comma-separated list of admin user identifiers (email, sub, or client_id) */
  adminUsers?: string;
}

export class ServiceApiGatewayStack extends AnahataCommonStack {
  public readonly restApi: RestApi;
  public readonly authorizer: IAuthorizer | undefined;
  public readonly apiResource: Resource;
  public readonly v1Resource: Resource;

  constructor(scope: Construct, id: string, props: ServiceApiGatewayStackProps) {
    super(scope, id, props);

    const allowedOrigins = props.env.stage === AnahataStage.PROD
      ? ['https://billing.anahata.ai', 'http://localhost:3000']
      : ['*'];

    const apiLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/AnahataBillingServiceApi-${props.env.stage}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.restApi = new RestApi(this, 'AnahataBillingServiceApi', {
      restApiName: `Anahata Billing Service API - ${props.env.stackSuffix()}`,
      description: 'REST API for Anahata Billing Platform',
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key', 'X-Amz-Security-Token'],
      },
      deployOptions: {
        stageName: props.env.stage,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        loggingLevel: MethodLoggingLevel.INFO,
        metricsEnabled: true,
        accessLogDestination: new LogGroupLogDestination(apiLogGroup),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
      },
    });

    // ── Dedicated Billing Authorizer Lambda ──
    // Completely independent of Anahata Aika — queries BillingUsers and BillingAccessRoles
    const authorizerRole = new iam.Role(this, 'BillingAuthorizerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant read access to Billing tables
    const billingUsersTable = dynamodb.Table.fromTableName(this, 'BillingUsersTable', 'BillingUsers');
    const billingRolesTable = dynamodb.Table.fromTableName(this, 'BillingRolesTable', 'BillingAccessRoles');
    billingUsersTable.grantReadData(authorizerRole);
    billingRolesTable.grantReadData(authorizerRole);

    const authorizerFn = new Function(this, 'BillingAuthorizerLambda', {
      functionName: `BillingServiceAuthorizerLambda-${props.env.stage}`,
      code: Code.fromAsset('dist/lambda'),
      handler: 'billing-authorizer.handler',
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      role: authorizerRole,
      environment: {
        USER_POOL_ID: props.cognitoUserPoolId,
        CLIENT_IDS: props.cognitoClientIds,
        ADMIN_USERS: props.adminUsers || '',
        USERS_TABLE_NAME: 'BillingUsers',
        ACCESS_ROLES_TABLE_NAME: 'BillingAccessRoles',
      },
    });

    authorizerFn.addPermission('ApiGatewayInvokePermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    // Authorizer
    let authorizer: IAuthorizer | undefined;
    const cfnAuthorizer = new CfnAuthorizer(this, 'BillingLambdaAuthorizer', {
      restApiId: this.restApi.restApiId,
      name: `BillingServiceAuthorizer-${props.env.stage}`,
      type: 'REQUEST',
      authorizerUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${authorizerFn.functionArn}/invocations`,
      authorizerResultTtlInSeconds: 0,
      identitySource: 'method.request.header.Authorization',
    });
    authorizer = { authorizerId: cfnAuthorizer.ref, authorizationType: AuthorizationType.CUSTOM } as IAuthorizer;
    this.authorizer = authorizer;

    // Health check
    const healthResource = this.restApi.root.addResource('health');
    healthResource.addMethod('GET', new MockIntegration({
      integrationResponses: [{ statusCode: '200', responseTemplates: { 'application/json': '{"status":"healthy"}' } }],
      requestTemplates: { 'application/json': '{ "statusCode": 200 }' },
    }), { authorizationType: AuthorizationType.NONE, methodResponses: [{ statusCode: '200', responseModels: { 'application/json': Model.EMPTY_MODEL } }] });

    // API resources
    this.v1Resource = this.restApi.root.addResource('apiv1');
    this.apiResource = this.v1Resource.addResource('{orgId}');

    // CORS error responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': "'*'",
      'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token'",
      'Access-Control-Allow-Methods': "'*'",
    };
    new GatewayResponse(this, 'Default4xx', { restApi: this.restApi as any, type: ResponseType.DEFAULT_4XX, responseHeaders: corsHeaders });
    new GatewayResponse(this, 'Default5xx', { restApi: this.restApi as any, type: ResponseType.DEFAULT_5XX, responseHeaders: corsHeaders });

    // Custom domain
    if (props.domainName && props.certificateArn) {
      const cert = Certificate.fromCertificateArn(this, 'Cert', props.certificateArn);
      const domain = new DomainName(this, 'ApiDomain', { domainName: props.domainName, certificate: cert });
      domain.addBasePathMapping(this.restApi, { basePath: '', stage: this.restApi.deploymentStage });

      if (props.hostedZone) {
        new ARecord(this, 'ApiAliasRecord', {
          zone: props.hostedZone,
          recordName: props.domainName.replace(`.${props.hostedZone.zoneName}`, ''),
          target: RecordTarget.fromAlias({ bind: () => ({ dnsName: domain.domainNameAliasDomainName, hostedZoneId: domain.domainNameAliasHostedZoneId }) }),
        });
      }
    }

    // Outputs
    new CfnOutput(this, 'RestApiUrl', { value: this.restApi.url, exportName: `${this.stackName}-RestApiUrl` });
    new CfnOutput(this, 'RestApiId', { value: this.restApi.restApiId, exportName: `${this.stackName}-RestApiId` });
  }
}
