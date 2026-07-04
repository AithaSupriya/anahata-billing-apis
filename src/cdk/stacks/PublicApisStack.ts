import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { LambdaIntegration, AuthorizationType, type Resource } from 'aws-cdk-lib/aws-apigateway';
import { AnahataCommonStack, type CommonStackProps } from '@anahata/cdk-commons';

export interface PublicApisStackProps extends CommonStackProps {
  v1Resource: Resource;
  cognitoUserPoolId: string;
}

/**
 * PublicApisStack — Unauthenticated endpoints (accept-invitation, health).
 */
export class PublicApisStack extends AnahataCommonStack {
  public readonly acceptInvitationFunction: lambda.Function;
  public readonly publicResource: Resource;

  constructor(scope: Construct, id: string, props: PublicApisStackProps) {
    super(scope, id, props);

    const userPoolArn = `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.cognitoUserPoolId}`;
    const invitationsTable = dynamodb.Table.fromTableName(this, 'InvitationsTable', 'BillingInvitations');
    const usersTable = dynamodb.Table.fromTableName(this, 'UsersTable', 'BillingUsers');

    const lambdaRole = new iam.Role(this, 'BillingPublicApisRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: `AnahataBillingPublicApisRole-${props.env.stage}`,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    invitationsTable.grantReadWriteData(lambdaRole);
    usersTable.grantReadWriteData(lambdaRole);
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminGetUser'],
      resources: [userPoolArn],
    }));

    this.acceptInvitationFunction = new lambda.Function(this, 'AcceptInvitationLambda', {
      functionName: `AnahataBillingAcceptInvitationLambda`,
      code: lambda.Code.fromAsset('dist/lambda'),
      handler: 'accept-invitation.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      role: lambdaRole,
      environment: {
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        USERS_TABLE_NAME: 'BillingUsers',
        INVITATIONS_TABLE_NAME: 'BillingInvitations',
      },
    });

    // Public route: POST /apiv1/public/accept-invitation
    const publicResource = props.v1Resource.addResource('public');
    this.publicResource = publicResource;
    const invitationsPublic = publicResource.addResource('accept-invitation');
    invitationsPublic.addMethod('POST', new LambdaIntegration(this.acceptInvitationFunction), {
      authorizationType: AuthorizationType.NONE,
    });
  }
}
