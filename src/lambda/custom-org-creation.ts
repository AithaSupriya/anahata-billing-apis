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

import { ErrorCodes } from './common/error-codes.js';
import {
  successResponse,
  errorResponse,
  badRequest,
  methodNotAllowed,
  conflict,
  corsResponse,
  internalError,
} from './common/api-response.js';

// ── Environment Variables ──
const ORGANIZATIONS_TABLE_NAME = process.env.ORGANIZATIONS_TABLE_NAME || 'BillingOrganizations';
const USERS_TABLE_NAME = process.env.USERS_TABLE_NAME || 'BillingUsers';
const ACCESS_ROLES_TABLE_NAME = process.env.ACCESS_ROLES_TABLE_NAME || 'BillingAccessRoles';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';

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

function resolveUserId(event: APIGatewayProxyEvent): string {
  const userId = event.requestContext?.authorizer?.userId;
  if (!userId) throw new Error('userId is required — must be authenticated');
  return userId as string;
}

// ── Cognito User Creation ──
async function ensureCognitoUser(email: string, tempPassword?: string): Promise<string> {
  try {
    const existing = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: email,
      }),
    );
    const sub = existing.UserAttributes?.find(a => a.Name === 'sub')?.Value;
    return sub || email;
  } catch (err: any) {
    if (err.name !== 'UserNotFoundException') throw err;
  }

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
      MessageAction: 'SUPPRESS',
    }),
  );

  const sub = createResult.User?.Attributes?.find(a => a.Name === 'sub')?.Value;
  return sub || email;
}

// ── Structured Logger ──
function log(level: 'INFO' | 'WARN' | 'ERROR', context: string, message: string, extra?: Record<string, unknown>) {
  const entry = { timestamp: new Date().toISOString(), level, context, message, ...extra };
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
    if (method === 'OPTIONS') return corsResponse();

    // Route by HTTP method
    if (method === 'GET') {
      return await handleListOrgs(event, requestId);
    }

    if (method === 'DELETE') {
      log('INFO', 'deleteOrg', 'Processing DELETE', { requestId });
      return successResponse(200, { deleted: true });
    }

    if (method !== 'POST') {
      return methodNotAllowed();
    }

    return await handleCreateOrg(event, requestId);
  } catch (error: any) {
    log('ERROR', 'handler', 'Unhandled exception', {
      requestId,
      method: event.httpMethod,
      path: event.path,
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    });

    return internalError(requestId);
  }
};

// ── LIST ORGS ──
async function handleListOrgs(event: APIGatewayProxyEvent, requestId: string): Promise<APIGatewayProxyResult> {
  log('INFO', 'listOrgs', 'Processing GET /orgs/list', { requestId });

  const authContext = event.requestContext?.authorizer;
  const userId = authContext?.userId as string | undefined;

  log('INFO', 'listOrgs', 'Auth context resolved', { requestId, userId: userId || 'none', hasAuthorizer: !!authContext });

  if (!userId) {
    log('WARN', 'listOrgs', 'No userId in authorizer context, returning empty', { requestId });
    return successResponse(200, { userId: 'anonymous', organizations: [] });
  }

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
    return successResponse(200, { userId, organizations: [] });
  }

  const { BatchGetCommand } = await import('@aws-sdk/lib-dynamodb');
  const orgsResult = await ddb.send(new BatchGetCommand({
    RequestItems: {
      [ORGS_TABLE]: { Keys: orgIds.map(orgId => ({ orgId })) },
    },
  }));

  const organizations = orgsResult.Responses?.[ORGS_TABLE] || [];
  log('INFO', 'listOrgs', 'Returning organizations', { requestId, userId, count: organizations.length });

  return successResponse(200, { userId, organizations });
}

// ── CREATE ORG ──
async function handleCreateOrg(event: APIGatewayProxyEvent, requestId: string): Promise<APIGatewayProxyResult> {
  log('INFO', 'createOrg', 'Processing POST /orgs', { requestId });
  const userId = resolveUserId(event);

  let body: any;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest(ErrorCodes.INVALID_JSON, 'Invalid JSON in request body');
  }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return badRequest(ErrorCodes.MISSING_REQUIRED_FIELD, 'Organization name is required', 'name');
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

  const ownerRoleId = roleItems[0].accessRoleId;

  // Create Cognito user if email provided
  let cognitoSub: string | undefined;
  if (body.userEmail) {
    try {
      cognitoSub = await ensureCognitoUser(body.userEmail);
    } catch (err: any) {
      console.error('[CREATE_ORG] Cognito error:', err);
      return errorResponse(500, ErrorCodes.COGNITO_ERROR, 'Failed to create user account', { requestId });
    }
  }

  // Build organization item
  const creatorEmail = body.email || body.userEmail || event.requestContext?.authorizer?.email || '';
  const orgItem: Record<string, any> = {
    orgId,
    name: body.name.trim(),
    description: body.description || '',
    email: creatorEmail.trim(),
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };

  if (body.address) orgItem.address = body.address;
  if (body.FEIN) orgItem.FEIN = body.FEIN;
  if (body.orgDomainUrls?.length) orgItem.orgDomainUrls = body.orgDomainUrls;
  if (body.tags?.length) orgItem.tags = body.tags;

  // Build user item
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
      return conflict(ErrorCodes.ALREADY_EXISTS, 'Organization creation failed — one or more records already exist');
    }
    throw err;
  }

  log('INFO', 'createOrg', 'Organization created', { requestId, orgId, ownerRoleId, userId });

  return successResponse(201, {
    orgId,
    name: orgItem.name,
    accessRoleId: ownerRoleId,
    userId: userItem.userId,
    roles: roleItems.map(r => ({ accessRoleId: r.accessRoleId, name: r.accessRoleName })),
  });
}
