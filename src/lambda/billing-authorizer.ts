/**
 * Billing Service Authorizer — Dedicated authorizer for the Billing platform.
 *
 * This is completely independent of Anahata Aika. It validates Cognito tokens
 * against the Billing-specific DynamoDB tables (BillingUsers, BillingAccessRoles).
 *
 * Flow:
 *   1. OPTIONS → Allow (CORS preflight)
 *   2. No token → Deny
 *   3. Validate Cognito JWT (shared user pool, billing client IDs)
 *   4. Open operations (create org, list orgs) → Allow for any authenticated user
 *   5. Org-scoped operations → Check user membership in BillingUsers + role policies
 *   6. Deny if not found or insufficient permissions
 *
 * Table schemas:
 *   BillingUsers:       PK = orgId, SK = userId
 *   BillingAccessRoles: PK = orgId, SK = accessRoleId
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';

// Note: The authorizer uses API Gateway's native policy document format,
// not the standard API response helpers (which return APIGatewayProxyResult).
// Error codes are used in logs for consistency.
import { ErrorCodes } from './common/error-codes.js';

// ── Environment Variables ──
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const CLIENT_IDS = (process.env.CLIENT_IDS || '').split(',').filter(Boolean);
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').filter(Boolean);
const USERS_TABLE = process.env.USERS_TABLE_NAME || 'BillingUsers';
const ACCESS_ROLES_TABLE = process.env.ACCESS_ROLES_TABLE_NAME || 'BillingAccessRoles';

// ── Clients ──
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ── JWT Verifier ──
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'access',
  clientId: CLIENT_IDS.length > 1 ? CLIENT_IDS : CLIENT_IDS[0] || '',
});

// ── Types ──
interface AuthContext {
  userId: string;
  orgId: string;
  isAdmin: string;
  [key: string]: string;
}

// ── Open Operations ──
// These don't require org membership — any authenticated user can access them.
function isOpenOperation(path: string, httpMethod: string): boolean {
  if (path === '/apiv1/orgs' && httpMethod === 'POST') return true;
  if (path === '/apiv1/orgs/list' && httpMethod === 'GET') return true;
  if (/^\/apiv1\/orgs\/[^/]+$/.test(path) && httpMethod === 'GET') return true;
  if (path.includes('/public/')) return true;
  return false;
}

// ── Helpers ──
function generatePolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context: AuthContext,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
    },
    context,
  };
}

function extractOrgId(event: APIGatewayRequestAuthorizerEvent): string {
  if (event.pathParameters?.orgId) return event.pathParameters.orgId;
  const header = event.headers?.['x-organization-id'] || event.headers?.['X-Organization-Id'];
  if (header) return header;
  return '';
}

function extractAction(event: APIGatewayRequestAuthorizerEvent): string {
  const method = event.httpMethod || '';
  const path = event.resource || event.requestContext?.resourcePath || '';

  const segments = path.split('/').filter(Boolean);
  let resource = 'unknown';
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (seg.startsWith('{') && seg.endsWith('}')) continue;
    if (/^[0-9a-f-]{20,}$/i.test(seg)) continue;
    if (seg === 'apiv1') continue;
    resource = seg;
    break;
  }

  const operation = method === 'GET' ? 'read'
    : method === 'DELETE' ? 'delete'
    : 'write';

  return `${resource}:${operation}`;
}

// ── Validate Org Membership ──
async function validateOrgMembership(orgId: string, userId: string): Promise<{ found: boolean; roleIds: string[] }> {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { orgId, userId },
    }));
    if (!result.Item) return { found: false, roleIds: [] };
    return {
      found: true,
      roleIds: result.Item.accessRoles || result.Item.roles || [],
    };
  } catch (error) {
    console.error(`[BillingAuthz] ${ErrorCodes.DATABASE_ERROR} checking membership:`, error);
    return { found: false, roleIds: [] };
  }
}

// ── Resolve User Policies ──
async function resolveUserActions(orgId: string, roleIds: string[]): Promise<string[]> {
  if (roleIds.length === 0) return [];

  try {
    const keys = roleIds.map(roleId => ({ orgId, accessRoleId: roleId }));
    const allActions: string[] = [];

    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      const result = await ddb.send(new BatchGetCommand({
        RequestItems: { [ACCESS_ROLES_TABLE]: { Keys: batch } },
      }));
      const items = result.Responses?.[ACCESS_ROLES_TABLE] || [];
      for (const item of items) {
        if (Array.isArray(item.actions)) allActions.push(...item.actions);
      }
    }

    return [...new Set(allActions)];
  } catch (error) {
    console.error(`[BillingAuthz] ${ErrorCodes.DATABASE_ERROR} resolving policies:`, error);
    return [];
  }
}

// ── Validate Policies ──
function checkPermission(userActions: string[], requiredAction: string): boolean {
  return userActions.some(action => {
    if (action === '*:*') return true;
    if (action === requiredAction) return true;
    if (action.endsWith(':*')) {
      const prefix = action.slice(0, action.indexOf(':'));
      return requiredAction.startsWith(`${prefix}:`);
    }
    return false;
  });
}

// ── Main Handler ──
export const handler = async (event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  console.log('[BillingAuthz] Request:', JSON.stringify({
    path: event.resource,
    method: event.httpMethod,
    pathParameters: event.pathParameters,
  }));

  try {
    const path = event.resource || event.requestContext?.resourcePath || '';
    const httpMethod = event.httpMethod || event.requestContext?.httpMethod || '';
    const orgId = extractOrgId(event);

    // 1. CORS preflight — always allow
    if (httpMethod === 'OPTIONS') {
      return generatePolicy('anonymous', 'Allow', event.methodArn, { userId: '', orgId, isAdmin: 'false' });
    }

    // 2. Extract and validate token
    let authToken = event.headers?.Authorization || event.headers?.authorization;
    if (authToken?.startsWith('Bearer ')) authToken = authToken.substring(7);

    if (!authToken) {
      console.log(`[BillingAuthz] ${ErrorCodes.MISSING_TOKEN} → Deny`);
      return generatePolicy('unknown', 'Deny', event.methodArn, { userId: '', orgId: '', isAdmin: 'false' });
    }

    let userId: string;
    let username: string;
    try {
      const payload = await verifier.verify(authToken);
      userId = payload.sub;
      username = (payload['cognito:username'] as string) || payload.sub;
    } catch (err) {
      console.error(`[BillingAuthz] ${ErrorCodes.INVALID_TOKEN}:`, err);
      return generatePolicy('unknown', 'Deny', event.methodArn, { userId: '', orgId: '', isAdmin: 'false' });
    }

    // 3. Admin bypass
    if (ADMIN_USERS.includes(username) || ADMIN_USERS.includes(userId)) {
      console.log('[BillingAuthz] Admin access:', username);
      return generatePolicy(userId, 'Allow', event.methodArn, { userId, orgId, isAdmin: 'true' });
    }

    // 4. Open operations — any authenticated user
    if (isOpenOperation(path, httpMethod)) {
      console.log('[BillingAuthz] Open operation:', path);
      return generatePolicy(userId, 'Allow', event.methodArn, { userId, orgId, isAdmin: 'false' });
    }

    // 5. Org-scoped — validate membership in BillingUsers
    if (!orgId) {
      console.log(`[BillingAuthz] ${ErrorCodes.ORG_ACCESS_DENIED} No orgId → Deny`);
      return generatePolicy(userId, 'Deny', event.methodArn, { userId, orgId: '', isAdmin: 'false' });
    }

    const membership = await validateOrgMembership(orgId, userId);
    if (!membership.found) {
      console.log(`[BillingAuthz] ${ErrorCodes.ORG_ACCESS_DENIED} User ${userId} not in org ${orgId} → Deny`);
      return generatePolicy(userId, 'Deny', event.methodArn, { userId, orgId, isAdmin: 'false' });
    }

    // 6. Check role-based permissions
    const userActions = await resolveUserActions(orgId, membership.roleIds);
    const requiredAction = extractAction(event);
    const allowed = checkPermission(userActions, requiredAction);

    if (!allowed) {
      console.log(`[BillingAuthz] ${ErrorCodes.INSUFFICIENT_PERMISSIONS} Action ${requiredAction} denied for ${userId}. Has: [${userActions.join(', ')}]`);
      return generatePolicy(userId, 'Deny', event.methodArn, { userId, orgId, isAdmin: 'false' });
    }

    console.log(`[BillingAuthz] Authorized: ${username} for ${requiredAction}`);
    return generatePolicy(userId, 'Allow', event.methodArn, { userId, orgId, isAdmin: 'false' });

  } catch (error) {
    console.error(`[BillingAuthz] ${ErrorCodes.INTERNAL_ERROR}:`, error);
    return generatePolicy('error', 'Deny', event.methodArn, { userId: '', orgId: '', isAdmin: 'false' });
  }
};
