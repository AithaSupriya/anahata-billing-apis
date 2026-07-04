/**
 * Custom Organization Creation Handler
 *
 * Handles: POST /apiv1/orgs
 *
 * Transactional operation that creates:
 *  1. Organization record in BillingOrganizations
 *  2. Default access roles (Owner, Admin, Manager, Employee)
 *  3. Cognito user (if email provided and user doesn't exist)
 *  4. First User record in BillingUsers with Owner role
 *
 * This replaces the generated CRUD create for organizations because
 * org creation requires multi-table transactional writes + Cognito setup.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// ── Environment Variables ──
const ORGANIZATIONS_TABLE_NAME = process.env.ORGANIZATIONS_TABLE_NAME || 'BillingOrganizations';
const USERS_TABLE_NAME = process.env.USERS_TABLE_NAME || 'BillingUsers';
const ACCESS_ROLES_TABLE_NAME = process.env.ACCESS_ROLES_TABLE_NAME || 'BillingAccessRoles';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@billing.anahata.ai';

// ── Default Roles ──
interface DefaultRole {
  name: string;
  actions: string[];
}

const DEFAULT_ROLES: DefaultRole[] = [
  { name: 'Owner', actions: ['*:*'] },
  {
    name: 'Admin',
    actions: [
      'products:read', 'products:write', 'products:delete',
      'plans:read', 'plans:write', 'plans:delete',
      'customers:read', 'customers:write', 'customers:delete',
      'subscriptions:read', 'subscriptions:write', 'subscriptions:delete',
      'users:read',
      'invitations:read', 'invitations:write',
      'organizations:read',
    ],
  },
  {
    name: 'Manager',
    actions: [
      'products:read',
      'plans:read',
      'users:read',
      'invitations:read',
      'organizations:read',
    ],
  },
  {
    name: 'Employee',
    actions: [
      'organizations:read',
    ],
  },
];

// ── Clients ──
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

// ── CORS Headers ──
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function apiResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function resolveUserId(event: APIGatewayProxyEvent): string {
  const userId = event.requestContext?.authorizer?.userId;
  if (!userId) throw new Error('userId is required — must be authenticated');
  return userId as string;
}

// ── Cognito User Creation ──
async function ensureCognitoUser(email: string, tempPassword?: string): Promise<string> {
  try {
    // Check if user already exists
    const existing = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: email,
      }),
    );
    // User already exists, return their sub
    const sub = existing.UserAttributes?.find(a => a.Name === 'sub')?.Value;
    return sub || email;
  } catch (err: any) {
    if (err.name !== 'UserNotFoundException') throw err;
  }

  // Create new Cognito user
  const password = tempPassword || `Temp${randomUUID().slice(0, 8)}!`;
  const createResult = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
      TemporaryPassword: password,
      MessageAction: 'SUPPRESS', // Don't send welcome email yet
    }),
  );

  const sub = createResult.User?.Attributes?.find(a => a.Name === 'sub')?.Value;
  return sub || email;
}

// ── Structured Logger ──
function log(level: 'INFO' | 'WARN' | 'ERROR', context: string, message: string, extra?: Record<string, unknown>) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    context,
    message,
    ...extra,
  };
  if (level === 'ERROR') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ── Main Handler ──
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const requestId = event.requestContext?.requestId || 'unknown';
  const method = event.httpMethod;
  const path = event.path;

  log('INFO', 'handler', 'Lambda invoked', { requestId, method, path, resource: event.resource });

  try {
    if (method === 'OPTIONS') return apiResponse(200, {});

    // Route by HTTP method — this Lambda handles POST, GET (list), and DELETE
    if (method === 'GET') {
      log('INFO', 'listOrgs', 'Processing GET /orgs/list', { requestId });

      // Extract userId from authorizer context
      // M2M tokens: authorizer sets userId = client_id (sub claim)
      const authContext = event.requestContext?.authorizer;
      const userId = authContext?.userId as string | undefined;

      log('INFO', 'listOrgs', 'Auth context resolved', { requestId, userId: userId || 'none', hasAuthorizer: !!authContext });

      if (!userId) {
        // No auth context — return empty (caller is not authenticated or authorizer is disabled)
        log('WARN', 'listOrgs', 'No userId in authorizer context, returning empty', { requestId });
        return apiResponse(200, { userId: 'anonymous', organizations: [] });
      }

      // Query user's org memberships
      const USERS_TABLE = process.env.USERS_TABLE_NAME || 'BillingUsers';
      const ORGS_TABLE = process.env.ORGANIZATIONS_TABLE_NAME || 'BillingOrganizations';

      log('INFO', 'listOrgs', 'Querying user memberships', { requestId, userId, table: USERS_TABLE, index: 'userId-index' });

      const memberships = await ddb.send(new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: 'userId-index',
        KeyConditionExpression: '#uid = :uid',
        ExpressionAttributeNames: { '#uid': 'userId' },
        ExpressionAttributeValues: { ':uid': userId },
        ProjectionExpression: 'orgId',
      }));

      const orgIds = (memberships.Items || []).map(m => m.orgId).filter(Boolean);
      log('INFO', 'listOrgs', 'Memberships found', { requestId, userId, orgCount: orgIds.length, orgIds });

      if (orgIds.length === 0) {
        return apiResponse(200, { userId, organizations: [] });
      }

      // Batch get org details
      const { BatchGetCommand } = await import('@aws-sdk/lib-dynamodb');
      const orgsResult = await ddb.send(new BatchGetCommand({
        RequestItems: {
          [ORGS_TABLE]: { Keys: orgIds.map(orgId => ({ orgId })) },
        },
      }));

      const organizations = orgsResult.Responses?.[ORGS_TABLE] || [];
      log('INFO', 'listOrgs', 'Returning organizations', { requestId, userId, count: organizations.length });

      return apiResponse(200, { userId, organizations });
    }

    if (method === 'DELETE') {
      // DELETE /apiv1/orgs/{orgId} — soft delete (for now just return success)
      log('INFO', 'deleteOrg', 'Processing DELETE', { requestId });
      return apiResponse(200, { deleted: true });
    }

    if (method !== 'POST') {
      return apiResponse(405, { error: 'Method not allowed' });
    }

    log('INFO', 'createOrg', 'Processing POST /orgs', { requestId });
    const userId = resolveUserId(event);

    let body: any;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return apiResponse(400, { error: 'Invalid JSON in request body' });
    }

    // Validate required fields
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return apiResponse(400, { error: 'Organization name is required' });
    }

    const now = new Date().toISOString();
    const orgId = randomUUID();

    // Generate role IDs
    const roleItems = DEFAULT_ROLES.map(role => ({
      accessRoleId: randomUUID(),
      orgId,
      accessRoleName: role.name,
      actions: role.actions,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    }));

    // Owner role is the first one
    const ownerRoleId = roleItems[0].accessRoleId;

    // Create Cognito user if email provided
    let cognitoSub: string | undefined;
    if (body.userEmail) {
      try {
        cognitoSub = await ensureCognitoUser(body.userEmail);
      } catch (err: any) {
        console.error('[CREATE_ORG] Cognito error:', err);
        return apiResponse(500, { error: 'Failed to create user account' });
      }
    }

    // Build organization item — include email from the authenticated user
    const creatorEmail = body.email || body.userEmail || event.requestContext?.authorizer?.email || '';
    const orgItem: Record<string, any> = {
      orgId,
      name: body.name.trim(),
      description: body.description || '',
      email: creatorEmail.trim(), // Organization contact email = creator's email
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };

    if (body.address) orgItem.address = body.address;
    if (body.FEIN) orgItem.FEIN = body.FEIN;
    if (body.orgDomainUrls?.length) orgItem.orgDomainUrls = body.orgDomainUrls;
    if (body.tags?.length) orgItem.tags = body.tags;

    // Build user item — populate name from body or use email prefix as fallback
    const firstName = (body.userFirstName || body.firstName || '').trim();
    const lastName = (body.userLastName || body.lastName || '').trim();
    const userEmail = (body.userEmail || body.email || creatorEmail || '').trim();
    const userItem = {
      userId: cognitoSub || userId,
      orgId,
      userFirstName: firstName || userEmail.split('@')[0] || 'Owner',
      userLastName: lastName,
      email: userEmail,
      accessRoles: [ownerRoleId],
      groups: [],
      createdAt: now,
      updatedAt: now,
    };

    // Transactional write: org + all roles + user
    const transactItems: any[] = [
      {
        Put: {
          TableName: ORGANIZATIONS_TABLE_NAME,
          Item: orgItem,
          ConditionExpression: 'attribute_not_exists(orgId)',
        },
      },
      ...roleItems.map(roleItem => ({
        Put: {
          TableName: ACCESS_ROLES_TABLE_NAME,
          Item: roleItem,
          ConditionExpression: 'attribute_not_exists(accessRoleId)',
        },
      })),
      {
        Put: {
          TableName: USERS_TABLE_NAME,
          Item: userItem,
          ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(orgId)',
        },
      },
    ];

    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (err: any) {
      if (err.name === 'TransactionCanceledException') {
        const reasons = (err.CancellationReasons ?? []) as Array<{ Code?: string }>;
        console.error('[CREATE_ORG] Transaction cancelled:', reasons);
        return apiResponse(409, {
          error: 'Organization creation failed — one or more records already exist',
          details: reasons.filter(r => r.Code && r.Code !== 'None'),
        });
      }
      throw err;
    }

    console.log(`[CREATE_ORG] orgId=${orgId} ownerRoleId=${ownerRoleId} userId=${userId}`);

    return apiResponse(201, {
      orgId,
      name: orgItem.name,
      accessRoleId: ownerRoleId,
      userId: userItem.userId,
      roles: roleItems.map(r => ({ accessRoleId: r.accessRoleId, name: r.accessRoleName })),
    });
  } catch (error: any) {
    log('ERROR', 'handler', 'Unhandled exception', {
      requestId: event.requestContext?.requestId,
      method: event.httpMethod,
      path: event.path,
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
      code: error.code || error.$metadata?.httpStatusCode,
    });

    // In sandbox/dev, return detailed error info for debugging
    const stage = event.requestContext?.stage || 'unknown';
    if (stage === 'sandbox' || stage === 'dev') {
      return apiResponse(500, {
        error: error.message || 'Internal server error',
        name: error.name,
        location: `custom-org-creation.handler [${event.httpMethod} ${event.path}]`,
        requestId: event.requestContext?.requestId,
        stack: error.stack?.split('\n').slice(0, 5),
      });
    }

    return apiResponse(500, { error: 'Internal server error' });
  }
};
