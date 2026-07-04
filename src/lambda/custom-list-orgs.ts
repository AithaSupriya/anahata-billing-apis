/**
 * Custom List Organizations Handler
 *
 * Handles: GET /apiv1/orgs/list
 *
 * Returns only organizations that the authenticated user belongs to.
 * Strategy:
 *  1. Query BillingUsers by userId GSI to get all orgIds for the user
 *  2. Batch-get organization details from BillingOrganizations
 *
 * This is a custom handler because the generated list operation would
 * return ALL organizations (no user-scoping).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// ── Environment Variables ──
const USERS_TABLE_NAME = process.env.USERS_TABLE_NAME || 'BillingUsers';
const ORGANIZATIONS_TABLE_NAME = process.env.ORGANIZATIONS_TABLE_NAME || 'BillingOrganizations';

// ── Clients ──
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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

/**
 * Query the userId-index GSI on BillingUsers to find all orgs for this user.
 */
async function getUserOrgMemberships(userId: string) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: USERS_TABLE_NAME,
      IndexName: 'userId-index',
      KeyConditionExpression: '#uid = :uid',
      ExpressionAttributeNames: { '#uid': 'userId' },
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'orgId, accessRoles, groups, email, userFirstName, userLastName',
    }),
  );

  return result.Items ?? [];
}

/**
 * Batch-get organization records by orgId.
 * DynamoDB BatchGetItem supports up to 100 keys per call.
 */
async function batchGetOrganizations(orgIds: string[]) {
  if (orgIds.length === 0) return [];

  // Chunk into batches of 100 (DDB limit)
  const chunks: string[][] = [];
  for (let i = 0; i < orgIds.length; i += 100) {
    chunks.push(orgIds.slice(i, i + 100));
  }

  const allOrgs: Record<string, any>[] = [];

  for (const chunk of chunks) {
    const result = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [ORGANIZATIONS_TABLE_NAME]: {
            Keys: chunk.map(orgId => ({ orgId })),
            ProjectionExpression: 'orgId, #n, description, createdAt, updatedAt',
            ExpressionAttributeNames: { '#n': 'name' },
          },
        },
      }),
    );

    const items = result.Responses?.[ORGANIZATIONS_TABLE_NAME] ?? [];
    allOrgs.push(...items);
  }

  return allOrgs;
}

// ── Main Handler ──
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('EVENT:', JSON.stringify(event));

  try {
    if (event.httpMethod === 'OPTIONS') return apiResponse(200, {});

    if (event.httpMethod !== 'GET') {
      return apiResponse(405, { error: 'Method not allowed' });
    }

    const userId = resolveUserId(event);

    // Step 1: Get all org memberships for this user
    const memberships = await getUserOrgMemberships(userId);

    if (memberships.length === 0) {
      return apiResponse(200, { userId, organizations: [] });
    }

    // Step 2: Batch-get organization details
    const orgIds = memberships.map(m => m.orgId).filter(Boolean);
    const orgs = await batchGetOrganizations(orgIds);

    // Step 3: Merge membership data with org details
    const orgMap = new Map(orgs.map(org => [org.orgId, org]));
    const organizations = memberships
      .map(membership => {
        const org = orgMap.get(membership.orgId);
        if (!org) return null;
        return {
          orgId: org.orgId,
          name: org.name,
          description: org.description,
          accessRoles: membership.accessRoles ?? [],
          groups: membership.groups ?? [],
          createdAt: org.createdAt,
        };
      })
      .filter(Boolean);

    return apiResponse(200, { userId, organizations });
  } catch (error: any) {
    console.error('[LIST_ORGS] Handler error:', error);
    return apiResponse(500, { error: 'Failed to list organizations' });
  }
};
