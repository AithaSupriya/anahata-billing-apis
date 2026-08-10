/**
 * Public Website APIs Handler
 *
 * Unauthenticated endpoints for customer-facing website integrations.
 * Validated by x-api-key header against AnahataBillingApiKeys table.
 *
 * Routes:
 *   GET  /public/{orgId}/products           → list org's ACTIVE products
 *   GET  /public/{orgId}/plans              → list org's ACTIVE plans (optional ?productId filter)
 *   GET  /public/{orgId}/plans/{planId}     → get single plan
 *   POST /public/{orgId}/subscribe          → create/find customer + create subscription
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { ErrorCodes } from './common/error-codes.js';
import {
  successResponse,
  errorResponse,
  badRequest,
  notFound,
  unauthorized,
  corsResponse,
  internalError,
} from './common/api-response.js';
import { parsePaginationParams, buildPaginatedResponse } from './common/pagination.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PRODUCTS_TABLE = process.env.PRODUCTS_TABLE_NAME || 'AnahataBillingProducts';
const PLANS_TABLE = process.env.PLANS_TABLE_NAME || 'AnahataBillingPricingPlans';
const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE_NAME || 'AnahataBillingCustomers';
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE_NAME || 'AnahataBillingSubscriptions';
const API_KEYS_TABLE = process.env.API_KEYS_TABLE_NAME || 'AnahataBillingApiKeys';

function log(level: string, message: string, data?: Record<string, unknown>) {
  const entry = { level, message, timestamp: new Date().toISOString(), ...data };
  console.log(JSON.stringify(entry));
}

// ── API KEY VALIDATION ──
async function validateApiKey(apiKey: string, orgId: string): Promise<boolean> {
  if (!apiKey) return false;

  try {
    // First try: look up by keyValue via GSI (for keys with generated keyValue)
    try {
      const gsiResult = await ddb.send(new QueryCommand({
        TableName: API_KEYS_TABLE,
        IndexName: 'keyValue-index',
        KeyConditionExpression: 'keyValue = :kv',
        ExpressionAttributeValues: { ':kv': apiKey },
      }));

      if (gsiResult.Items && gsiResult.Items.length > 0) {
        const key = gsiResult.Items[0];
        if (key.orgId !== orgId) return false;
        const status = key.status || 'ACTIVE';
        if (status === 'REVOKED') return false;
        return true;
      }
    } catch (gsiErr) {
      // GSI might not exist yet — fall through to direct lookup
      log('info', 'GSI lookup failed, trying direct lookup', { error: (gsiErr as Error).message });
    }

    // Fallback: look up by apiKeyId directly (for keys created before keyValue generation)
    const directResult = await ddb.send(new GetCommand({
      TableName: API_KEYS_TABLE,
      Key: { orgId, apiKeyId: apiKey },
    }));

    if (directResult.Item) {
      const status = directResult.Item.status || 'ACTIVE';
      if (status === 'REVOKED') return false;
      return true;
    }

    return false;
  } catch (err) {
    log('error', 'Failed to validate API key', { error: (err as Error).message });
    return false;
  }
}

// ── LIST PUBLIC PRODUCTS ──
async function listPublicProducts(orgId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  log('info', 'Listing public products', { orgId });

  const { limit, cursor } = parsePaginationParams(event);

  const result = await ddb.send(new QueryCommand({
    TableName: PRODUCTS_TABLE,
    KeyConditionExpression: 'orgId = :orgId',
    FilterExpression: '#status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':orgId': orgId, ':active': 'ACTIVE' },
    Limit: limit,
    ...(cursor && { ExclusiveStartKey: cursor }),
  }));

  const items = result.Items || [];
  return successResponse(200, buildPaginatedResponse(items, limit, result.LastEvaluatedKey));
}

// ── LIST PUBLIC PLANS ──
async function listPublicPlans(orgId: string, productId: string | undefined, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  log('info', 'Listing public plans', { orgId, productId });

  const { limit, cursor } = parsePaginationParams(event);

  let filterExpression = '#status = :active';
  const expressionValues: Record<string, unknown> = { ':orgId': orgId, ':active': 'ACTIVE' };
  const expressionNames: Record<string, string> = { '#status': 'status' };

  if (productId) {
    filterExpression += ' AND productId = :productId';
    expressionValues[':productId'] = productId;
  }

  const result = await ddb.send(new QueryCommand({
    TableName: PLANS_TABLE,
    KeyConditionExpression: 'orgId = :orgId',
    FilterExpression: filterExpression,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues,
    Limit: limit,
    ...(cursor && { ExclusiveStartKey: cursor }),
  }));

  const items = result.Items || [];
  return successResponse(200, buildPaginatedResponse(items, limit, result.LastEvaluatedKey));
}

// ── GET PUBLIC PLAN ──
async function getPublicPlan(orgId: string, planId: string): Promise<APIGatewayProxyResult> {
  log('info', 'Getting public plan', { orgId, planId });

  const result = await ddb.send(new GetCommand({
    TableName: PLANS_TABLE,
    Key: { orgId, planId },
  }));

  if (!result.Item || result.Item.status !== 'ACTIVE') {
    return notFound(ErrorCodes.PLAN_NOT_FOUND, 'Plan not found', 'planId');
  }

  return successResponse(200, result.Item);
}

// ── PUBLIC SUBSCRIBE ──
async function publicSubscribe(orgId: string, body: Record<string, unknown>): Promise<APIGatewayProxyResult> {
  const { email, name, planId, company, phone } = body as {
    email?: string; name?: string; planId?: string; company?: string; phone?: string;
  };

  if (!email || !planId) {
    return badRequest(ErrorCodes.MISSING_REQUIRED_FIELD, 'email and planId are required', 'email,planId');
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return badRequest(ErrorCodes.INVALID_EMAIL, 'Invalid email format', 'email');
  }

  log('info', 'Public subscribe request', { orgId, email, planId });

  // 1. Validate plan exists and is active
  const planResult = await ddb.send(new GetCommand({
    TableName: PLANS_TABLE,
    Key: { orgId, planId },
  }));
  if (!planResult.Item || planResult.Item.status !== 'ACTIVE') {
    return notFound(ErrorCodes.PLAN_NOT_FOUND, 'Plan not found or not active', 'planId');
  }
  const plan = planResult.Item;

  // 2. Find or create customer by email
  let customer: Record<string, unknown> | undefined;

  // Query for existing customer with this email using GSI
  try {
    const customerQuery = await ddb.send(new QueryCommand({
      TableName: CUSTOMERS_TABLE,
      IndexName: 'email-index',
      KeyConditionExpression: 'orgId = :orgId AND email = :email',
      ExpressionAttributeValues: { ':orgId': orgId, ':email': email },
    }));
    if (customerQuery.Items && customerQuery.Items.length > 0) {
      customer = customerQuery.Items[0];
      log('info', 'Found existing customer', { customerId: customer!.customerId });
    }
  } catch {
    // If GSI doesn't exist, scan with filter (less efficient but works)
    const scanResult = await ddb.send(new QueryCommand({
      TableName: CUSTOMERS_TABLE,
      KeyConditionExpression: 'orgId = :orgId',
      FilterExpression: 'email = :email',
      ExpressionAttributeValues: { ':orgId': orgId, ':email': email },
    }));
    if (scanResult.Items && scanResult.Items.length > 0) {
      customer = scanResult.Items[0];
    }
  }

  if (!customer) {
    // Create new customer
    const customerId = randomUUID();
    const now = new Date().toISOString();
    customer = {
      orgId,
      customerId,
      name: name || email.split('@')[0],
      email,
      ...(phone && { phone }),
      ...(company && { company }),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: Date.now(),
    };
    await ddb.send(new PutCommand({ TableName: CUSTOMERS_TABLE, Item: customer }));
    log('info', 'Created new customer', { customerId });
  }

  // 3. Create subscription
  const now = new Date();
  const subscriptionId = randomUUID();

  let status: string;
  let trialEnd: string | undefined;

  if (plan.billingInterval === 'TRIAL' || (plan.trialDays && plan.trialDays > 0)) {
    status = 'FREE_TRIAL';
    const trialDays = plan.trialDays || 14;
    const trialEndDate = new Date(now);
    trialEndDate.setDate(trialEndDate.getDate() + trialDays);
    trialEnd = trialEndDate.toISOString();
  } else {
    status = 'ACTIVE';
  }

  // Calculate period end
  let periodEnd: string;
  if (trialEnd) {
    periodEnd = trialEnd;
  } else {
    const endDate = new Date(now);
    switch (plan.billingInterval) {
      case 'MONTHLY': endDate.setMonth(endDate.getMonth() + 1); break;
      case 'YEARLY': endDate.setFullYear(endDate.getFullYear() + 1); break;
      case 'ONE_TIME': endDate.setFullYear(endDate.getFullYear() + 10); break;
      default: endDate.setMonth(endDate.getMonth() + 1);
    }
    periodEnd = endDate.toISOString();
  }

  const subscription = {
    orgId,
    subscriptionId,
    customerId: customer.customerId as string,
    productId: plan.productId,
    planId,
    status,
    billingInterval: plan.billingInterval,
    price: plan.price,
    currency: plan.currency,
    currentPeriodStart: now.toISOString(),
    currentPeriodEnd: periodEnd,
    ...(trialEnd && { trialStart: now.toISOString(), trialEnd }),
    autoRenew: true,
    createdAt: now.toISOString(),
    updatedAt: Date.now(),
    createdBy: 'public-api',
  };

  await ddb.send(new PutCommand({ TableName: SUBSCRIPTIONS_TABLE, Item: subscription }));
  log('info', 'Created subscription', { subscriptionId, status });

  return successResponse(201, {
    customerId: customer.customerId,
    subscriptionId,
    status,
    planName: plan.name,
    ...(trialEnd && { trialEnd }),
  });
}

// ── ROUTER ──
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  log('info', 'Public website API request', {
    method: event.httpMethod,
    path: event.path,
    resource: event.resource,
  });

  try {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return corsResponse();
    }

    const orgId = event.pathParameters?.orgId;
    if (!orgId) {
      return badRequest(ErrorCodes.MISSING_REQUIRED_FIELD, 'orgId is required', 'orgId');
    }

    // Validate API key
    const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'] || '';
    const isValid = await validateApiKey(apiKey, orgId);
    if (!isValid) {
      return unauthorized(ErrorCodes.INVALID_API_KEY, 'Invalid or missing API key');
    }

    const method = event.httpMethod;
    const path = event.resource || event.path;

    // Route: GET /public/{orgId}/products
    if (method === 'GET' && path.includes('/products')) {
      return await listPublicProducts(orgId, event);
    }

    // Route: GET /public/{orgId}/plans/{planId}
    const planId = event.pathParameters?.planId;
    if (method === 'GET' && path.includes('/plans') && planId) {
      return await getPublicPlan(orgId, planId);
    }

    // Route: GET /public/{orgId}/plans
    if (method === 'GET' && path.includes('/plans')) {
      const productId = event.queryStringParameters?.productId;
      return await listPublicPlans(orgId, productId, event);
    }

    // Route: POST /public/{orgId}/subscribe
    if (method === 'POST' && path.includes('/subscribe')) {
      const body = JSON.parse(event.body || '{}');
      return await publicSubscribe(orgId, body);
    }

    return notFound(ErrorCodes.RESOURCE_NOT_FOUND, 'Not found');
  } catch (error: unknown) {
    const err = error as Error;
    log('error', 'Unhandled error in public website API', { error: err.message, stack: err.stack });
    return internalError();
  }
};
