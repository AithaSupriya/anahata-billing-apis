/**
 * Subscription Lifecycle Handler
 *
 * Routes:
 *   POST   /apiv1/{orgId}/subscriptions             → createSubscription
 *   PUT    /apiv1/{orgId}/subscriptions/{subId}      → upgradeOrDowngrade
 *   DELETE /apiv1/{orgId}/subscriptions/{subId}      → cancelSubscription
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE_NAME || 'AnahataBillingSubscriptions';
const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE_NAME || 'AnahataBillingCustomers';
const PLANS_TABLE = process.env.PLANS_TABLE_NAME || 'AnahataBillingPricingPlans';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function calculatePeriodEnd(start: Date, interval: string): Date {
  switch (interval) {
    case 'MONTHLY': return addMonths(start, 1);
    case 'YEARLY': return addMonths(start, 12);
    case 'ONE_TIME': return addMonths(start, 120); // 10 years (effectively forever)
    case 'TRIAL': return addDays(start, 14); // default trial, overridden by trialDays
    default: return addMonths(start, 1);
  }
}

// ── CREATE SUBSCRIPTION ──
async function handleCreate(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const orgId = event.pathParameters?.orgId || body.orgId;

  if (!orgId || !body.customerId || !body.planId) {
    return respond(400, { error: 'orgId, customerId, and planId are required' });
  }

  // Validate customer exists
  const customerResult = await ddb.send(new GetCommand({
    TableName: CUSTOMERS_TABLE, Key: { orgId, customerId: body.customerId },
  }));
  if (!customerResult.Item) return respond(404, { error: 'Customer not found' });

  // Validate plan exists
  const planResult = await ddb.send(new GetCommand({
    TableName: PLANS_TABLE, Key: { orgId, planId: body.planId },
  }));
  if (!planResult.Item) return respond(404, { error: 'Plan not found' });

  const plan = planResult.Item;
  const now = new Date();
  const subscriptionId = randomUUID();

  // Determine status and dates based on plan type
  let status: string;
  let trialStart: string | undefined;
  let trialEnd: string | undefined;
  let periodStart = now.toISOString();
  let periodEnd: string;

  if (plan.billingInterval === 'TRIAL' || (plan.trialDays && plan.trialDays > 0)) {
    status = 'FREE_TRIAL';
    trialStart = now.toISOString();
    trialEnd = addDays(now, plan.trialDays || 14).toISOString();
    periodEnd = trialEnd;
  } else if (plan.price === 0) {
    status = 'ACTIVE'; // Free plan = immediately active
    periodEnd = calculatePeriodEnd(now, plan.billingInterval).toISOString();
  } else {
    status = 'ACTIVE'; // Paid plan (payment will be handled in Phase 8)
    periodEnd = calculatePeriodEnd(now, plan.billingInterval).toISOString();
  }

  const subscription = {
    orgId,
    subscriptionId,
    customerId: body.customerId,
    productId: plan.productId,
    planId: body.planId,
    status,
    billingInterval: plan.billingInterval,
    price: plan.price,
    currency: plan.currency,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    ...(trialStart && { trialStart }),
    ...(trialEnd && { trialEnd }),
    autoRenew: body.autoRenew !== false,
    metadata: body.metadata || {},
    createdAt: now.toISOString(),
    updatedAt: Date.now(),
    createdBy: event.requestContext?.authorizer?.userId || 'system',
  };

  await ddb.send(new PutCommand({ TableName: SUBSCRIPTIONS_TABLE, Item: subscription }));

  return respond(201, subscription);
}

// ── UPDATE (UPGRADE/DOWNGRADE) ──
async function handleUpdate(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const orgId = event.pathParameters?.orgId;
  const subscriptionId = event.pathParameters?.subscriptionId;

  if (!orgId || !subscriptionId || !body.planId) {
    return respond(400, { error: 'orgId, subscriptionId, and planId are required' });
  }

  // Get existing subscription
  const subResult = await ddb.send(new GetCommand({
    TableName: SUBSCRIPTIONS_TABLE, Key: { orgId, subscriptionId },
  }));
  if (!subResult.Item) return respond(404, { error: 'Subscription not found' });

  const existing = subResult.Item;
  if (existing.status === 'CANCELLED') {
    return respond(409, { error: 'Cannot upgrade a cancelled subscription' });
  }

  // Validate new plan
  const planResult = await ddb.send(new GetCommand({
    TableName: PLANS_TABLE, Key: { orgId, planId: body.planId },
  }));
  if (!planResult.Item) return respond(404, { error: 'New plan not found' });

  const newPlan = planResult.Item;
  const now = new Date();

  // Optimistic locking
  if (body.updatedAt !== undefined && existing.updatedAt !== body.updatedAt) {
    return respond(409, { error: 'Subscription was modified. Reload and retry.', code: 'OPTIMISTIC_LOCK_CONFLICT' });
  }

  const updateResult = await ddb.send(new UpdateCommand({
    TableName: SUBSCRIPTIONS_TABLE,
    Key: { orgId, subscriptionId },
    UpdateExpression: 'SET planId = :planId, previousPlanId = :prevPlan, price = :price, currency = :currency, billingInterval = :interval, updatedAt = :now',
    ExpressionAttributeValues: {
      ':planId': body.planId,
      ':prevPlan': existing.planId,
      ':price': newPlan.price,
      ':currency': newPlan.currency,
      ':interval': newPlan.billingInterval,
      ':now': Date.now(),
    },
    ReturnValues: 'ALL_NEW',
  }));

  return respond(200, updateResult.Attributes);
}

// ── CANCEL ──
async function handleCancel(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const orgId = event.pathParameters?.orgId;
  const subscriptionId = event.pathParameters?.subscriptionId;

  if (!orgId || !subscriptionId) {
    return respond(400, { error: 'orgId and subscriptionId are required' });
  }

  const subResult = await ddb.send(new GetCommand({
    TableName: SUBSCRIPTIONS_TABLE, Key: { orgId, subscriptionId },
  }));
  if (!subResult.Item) return respond(404, { error: 'Subscription not found' });

  const existing = subResult.Item;
  if (existing.status === 'CANCELLED') {
    return respond(409, { error: 'Subscription is already cancelled' });
  }

  const now = new Date();
  const immediate = body.immediate !== false;
  const effectiveEndDate = immediate ? now.toISOString() : existing.currentPeriodEnd;

  await ddb.send(new UpdateCommand({
    TableName: SUBSCRIPTIONS_TABLE,
    Key: { orgId, subscriptionId },
    UpdateExpression: 'SET #status = :cancelled, cancelledAt = :now, cancelReason = :reason, updatedAt = :ts',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':cancelled': 'CANCELLED',
      ':now': now.toISOString(),
      ':reason': body.cancelReason || 'User requested',
      ':ts': Date.now(),
    },
  }));

  return respond(200, {
    subscriptionId,
    status: 'CANCELLED',
    cancelledAt: now.toISOString(),
    cancelReason: body.cancelReason || 'User requested',
    effectiveEndDate,
  });
}

// ── ROUTER ──
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('EVENT:', JSON.stringify(event));

  try {
    if (event.httpMethod === 'OPTIONS') return respond(200, {});

    const method = event.httpMethod;
    const hasSubId = !!event.pathParameters?.subscriptionId;

    if (method === 'POST' && !hasSubId) return await handleCreate(event);
    if (method === 'PUT' && hasSubId) return await handleUpdate(event);
    if (method === 'DELETE' && hasSubId) return await handleCancel(event);

    return respond(405, { error: 'Method not allowed' });
  } catch (error: any) {
    console.error('[SUBSCRIPTION] Error:', error);
    return respond(500, { error: error.message || 'Internal server error' });
  }
};
