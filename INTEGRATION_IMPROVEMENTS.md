# Anahata Billing Platform — Integration Improvements Implementation Plan

This document outlines the implementation plan for transforming the billing APIs from an internal-use service into a professional, developer-friendly integration platform.

---

## Priority & Timeline Overview

| Tier | Priority | Items | Effort |
|------|----------|-------|--------|
| **Tier 1** | Do Now | OpenAPI spec, pagination, error standardization, rate limit headers | 1–2 weeks |
| **Tier 2** | Do Soon | TypeScript SDK, webhooks, versioning policy | 3–4 weeks |
| **Tier 3** | Do Later | Embeddable UI, customer portal, sandbox/test mode, analytics | 6–8 weeks |

---


## Tier 1: Foundation (Week 1–2)

### 1.1 Generate OpenAPI Specification

**Goal:** Provide a machine-readable API spec that integrators can use to auto-generate clients, validate requests, and explore the API interactively.

**Implementation:**

1. Add Smithy-to-OpenAPI conversion to the `anahata-billing-model` build:
   ```bash
   # In anahata-billing-model/smithy-build.json, add:
   {
     "plugins": {
       "openapi": {
         "service": "com.anahata.billing#BillingService",
         "protocol": "aws.protocols#restJson1"
       }
     }
   }
   ```

2. Host the generated spec as a static endpoint:
   ```
   GET /apiv1/docs        → Swagger UI (HTML page)
   GET /apiv1/openapi.json → Raw OpenAPI 3.0 JSON spec
   ```

3. CDK implementation — add a new Lambda or S3-backed endpoint:
   ```typescript
   // src/cdk/stacks/DocsStack.ts
   // Serve openapi.json from S3 or inline in a Lambda response
   // Serve Swagger UI as static HTML pointing to the spec
   ```

4. Include the OpenAPI spec in the npm package:
   ```
   @anahata/billing-model/openapi.json
   ```

**Deliverables:**
- `openapi.json` auto-generated on every build
- `/apiv1/docs` endpoint serving Swagger UI
- Spec published as part of the `@anahata/billing-model` package

---

### 1.2 Standardize Error Responses

**Goal:** Every error response follows a consistent, predictable format that integrators can reliably parse.

**Current state:** Errors are ad-hoc (`{ error: "message" }` or `{ error, details }` or `{ error, code }`).

**Target format:**
```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Customer not found",
    "target": "customerId",
    "details": [],
    "requestId": "abc-123",
    "timestamp": "2026-08-08T10:00:00Z"
  }
}
```

**Standard error codes:**
```typescript
// src/lambda/common/error-codes.ts
export const ErrorCodes = {
  // 400 Bad Request
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_JSON: 'INVALID_JSON',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_EMAIL: 'INVALID_EMAIL',

  // 401 Unauthorized
  INVALID_API_KEY: 'INVALID_API_KEY',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  MISSING_TOKEN: 'MISSING_TOKEN',

  // 403 Forbidden
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  ORG_ACCESS_DENIED: 'ORG_ACCESS_DENIED',

  // 404 Not Found
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',

  // 409 Conflict
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  OPTIMISTIC_LOCK_CONFLICT: 'OPTIMISTIC_LOCK_CONFLICT',
  SUBSCRIPTION_CANCELLED: 'SUBSCRIPTION_CANCELLED',
  INVITATION_NOT_PENDING: 'INVITATION_NOT_PENDING',

  // 429 Too Many Requests
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // 500 Internal Server Error
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
```

**Implementation:**
```typescript
// src/lambda/common/api-response.ts
export interface ApiError {
  code: string;
  message: string;
  target?: string;
  details?: ApiError[];
  requestId?: string;
  timestamp?: string;
}

export function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  options?: { target?: string; details?: ApiError[]; requestId?: string }
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      error: {
        code,
        message,
        target: options?.target,
        details: options?.details,
        requestId: options?.requestId,
        timestamp: new Date().toISOString(),
      },
    }),
  };
}

export function successResponse(statusCode: number, data: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(data) };
}
```

**Migration:** Update all Lambda handlers to use `errorResponse()` instead of inline `respond(4xx, { error: "..." })`.

---


### 1.3 Add Pagination to All List Endpoints

**Goal:** Every list endpoint supports cursor-based pagination with consistent parameters and response envelope.

**Request parameters:**
```
GET /apiv1/{orgId}/products?limit=20&cursor=eyJvcmdJZCI6...&sort=createdAt:desc
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Items per page (max 100) |
| `cursor` | string | — | Opaque cursor for next page (base64-encoded DynamoDB LastEvaluatedKey) |
| `sort` | string | `createdAt:desc` | Sort field and direction |

**Response envelope:**
```json
{
  "items": [...],
  "pagination": {
    "count": 20,
    "limit": 20,
    "hasMore": true,
    "nextCursor": "eyJvcmdJZCI6..."
  }
}
```

**Implementation:**
```typescript
// src/lambda/common/pagination.ts
export interface PaginationParams {
  limit: number;
  cursor?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: {
    count: number;
    limit: number;
    hasMore: boolean;
    nextCursor?: string;
  };
}

export function parsePaginationParams(event: APIGatewayProxyEvent): PaginationParams {
  const limit = Math.min(
    Math.max(parseInt(event.queryStringParameters?.limit || '20', 10), 1),
    100
  );

  let cursor: Record<string, unknown> | undefined;
  if (event.queryStringParameters?.cursor) {
    try {
      cursor = JSON.parse(
        Buffer.from(event.queryStringParameters.cursor, 'base64url').toString()
      );
    } catch {
      // Invalid cursor — start from beginning
    }
  }

  return { limit, cursor };
}

export function buildPaginatedResponse<T>(
  items: T[],
  limit: number,
  lastEvaluatedKey?: Record<string, unknown>
): PaginatedResponse<T> {
  return {
    items,
    pagination: {
      count: items.length,
      limit,
      hasMore: !!lastEvaluatedKey,
      ...(lastEvaluatedKey && {
        nextCursor: Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64url'),
      }),
    },
  };
}
```

**Apply to:**
- All generated CRUD list handlers (patch via `copy-generated.js`)
- `GET /apiv1/orgs/list` (custom handler)
- `GET /apiv1/public/{orgId}/products`
- `GET /apiv1/public/{orgId}/plans`

---

### 1.4 Rate Limiting with Standard Headers

**Goal:** Return proper rate limit headers so integrators can build resilient clients.

**Headers to include on every response:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1691500000
Retry-After: 5          (only on 429 responses)
```

**Implementation options:**

**Option A: API Gateway Usage Plans (recommended for v1)**

```typescript
// In ServiceApiGatewayStack.ts
const usagePlan = this.restApi.addUsagePlan('BillingApiUsagePlan', {
  name: 'BillingApiStandardPlan',
  throttle: {
    rateLimit: 100,    // requests per second
    burstLimit: 200,
  },
  quota: {
    limit: 10000,      // requests per day
    period: apigateway.Period.DAY,
  },
});
```

API Gateway automatically returns `429` with `Retry-After` when limits are exceeded.

**Option B: Lambda-level tracking (for per-org limits)**

Store request counts in DynamoDB or ElastiCache. Check on each request. More complex but allows per-organization rate limiting.

**Recommended:** Start with Option A (API Gateway level). Add per-org limits in Tier 2 when needed.

**Custom 429 response via Gateway Response:**
```typescript
new GatewayResponse(this, 'ThrottleResponse', {
  restApi: this.restApi,
  type: ResponseType.THROTTLED,
  responseHeaders: {
    'Access-Control-Allow-Origin': "'*'",
    'Retry-After': "'5'",
  },
  templates: {
    'application/json': JSON.stringify({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please retry after the specified time.',
        timestamp: '$context.requestTime',
      },
    }),
  },
});
```

---


## Tier 2: Developer Experience (Week 3–6)

### 2.1 TypeScript SDK

**Goal:** Publish a type-safe SDK that abstracts away HTTP calls, handles auth, retries, and pagination automatically.

**Package:** `@anahata/billing-sdk`

**Architecture:**
```
@anahata/billing-sdk/
├── src/
│   ├── index.ts              # Main export
│   ├── client.ts             # AnahataBillingClient class
│   ├── auth.ts               # Token management
│   ├── resources/
│   │   ├── organizations.ts  # client.organizations.create()
│   │   ├── products.ts       # client.products.list()
│   │   ├── plans.ts          # client.plans.create()
│   │   ├── customers.ts      # client.customers.list()
│   │   ├── subscriptions.ts  # client.subscriptions.create()
│   │   ├── invitations.ts    # client.invitations.send()
│   │   └── apiKeys.ts        # client.apiKeys.create()
│   ├── types/                # Generated from OpenAPI spec
│   │   ├── models.ts
│   │   └── params.ts
│   ├── errors.ts             # Typed error classes
│   └── utils/
│       ├── pagination.ts     # Auto-paginate iterator
│       └── retry.ts          # Exponential backoff
├── package.json
├── tsconfig.json
└── README.md
```

**Usage example:**
```typescript
import { AnahataBilling } from '@anahata/billing-sdk';

// Authenticated client (for dashboard/admin use)
const billing = new AnahataBilling({
  accessToken: 'eyJ...',
  orgId: 'org-uuid',
  baseUrl: 'https://billing-api.anahata.ai',
});

// Create a product
const product = await billing.products.create({
  name: 'Pro Plan',
  description: 'For growing teams',
  status: 'ACTIVE',
});

// List plans with auto-pagination
for await (const plan of billing.plans.list({ productId: product.productId })) {
  console.log(plan.name, plan.price);
}

// Create a subscription
const subscription = await billing.subscriptions.create({
  customerId: 'cust-uuid',
  planId: 'plan-uuid',
});

// Public client (for website integration)
const publicBilling = AnahataBilling.public({
  apiKey: 'bk_a1b2c3...',
  orgId: 'org-uuid',
});

const plans = await publicBilling.plans.list();
const result = await publicBilling.subscribe({
  email: 'user@example.com',
  planId: 'plan-uuid',
});
```

**Client implementation:**
```typescript
// src/client.ts
export class AnahataBilling {
  private baseUrl: string;
  private headers: Record<string, string>;

  public organizations: OrganizationsResource;
  public products: ProductsResource;
  public plans: PlansResource;
  public customers: CustomersResource;
  public subscriptions: SubscriptionsResource;
  public invitations: InvitationsResource;
  public apiKeys: ApiKeysResource;

  constructor(config: BillingConfig) {
    this.baseUrl = config.baseUrl || 'https://billing-api.anahata.ai';
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.accessToken}`,
    };

    const ctx = { baseUrl: this.baseUrl, headers: this.headers, orgId: config.orgId };
    this.organizations = new OrganizationsResource(ctx);
    this.products = new ProductsResource(ctx);
    this.plans = new PlansResource(ctx);
    this.customers = new CustomersResource(ctx);
    this.subscriptions = new SubscriptionsResource(ctx);
    this.invitations = new InvitationsResource(ctx);
    this.apiKeys = new ApiKeysResource(ctx);
  }

  static public(config: PublicConfig): PublicBilling {
    return new PublicBilling(config);
  }
}
```

**Error handling:**
```typescript
// src/errors.ts
export class BillingApiError extends Error {
  code: string;
  statusCode: number;
  target?: string;
  requestId?: string;

  constructor(response: ErrorResponse) {
    super(response.error.message);
    this.code = response.error.code;
    this.statusCode = response.statusCode;
    this.target = response.error.target;
    this.requestId = response.error.requestId;
  }
}

export class NotFoundError extends BillingApiError {}
export class ValidationError extends BillingApiError {}
export class RateLimitError extends BillingApiError {
  retryAfter: number;
}
export class ConflictError extends BillingApiError {}
```

**Retry logic:**
```typescript
// src/utils/retry.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000 } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof RateLimitError && attempt < maxRetries) {
        const delay = error.retryAfter * 1000 || baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      if (error instanceof BillingApiError && error.statusCode >= 500 && attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}
```

**Generation approach:** Use the OpenAPI spec from 1.1 to auto-generate types and method signatures. Use `openapi-typescript` for types, then hand-write the client shell for better DX.

**Publish to:**
- AWS CodeArtifact (`@anahata/billing-sdk`)
- Optionally npm public registry when ready for external integrators

---


### 2.2 Webhook System

**Goal:** Allow integrators to receive real-time notifications when billing events occur (subscription created, cancelled, trial expiring, etc.).

**Architecture:**

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│ Billing API  │────▶│ EventBridge /    │────▶│ Webhook Delivery │
│ (Lambda)     │     │ SQS Queue       │     │ Lambda           │
└──────────────┘     └─────────────────┘     └──────────────────┘
                                                      │
                                                      ▼
                                              ┌──────────────────┐
                                              │ Integrator's     │
                                              │ Endpoint (HTTPS) │
                                              └──────────────────┘
```

**DynamoDB Table:** `AnahataBillingWebhooks`

| Field | Type | Description |
|-------|------|-------------|
| orgId | String (PK) | Organization |
| webhookId | String (SK) | Webhook ID |
| url | String | HTTPS endpoint URL |
| events | String[] | Event types to subscribe to |
| secret | String | HMAC signing secret |
| status | String | ACTIVE / DISABLED |
| createdAt | String | ISO timestamp |

**Event Types:**
```typescript
export const WebhookEventTypes = {
  // Subscriptions
  'subscription.created': 'Subscription was created',
  'subscription.upgraded': 'Subscription plan was upgraded',
  'subscription.downgraded': 'Subscription plan was downgraded',
  'subscription.cancelled': 'Subscription was cancelled',
  'subscription.trial_expiring': 'Trial expires in 3 days',
  'subscription.renewed': 'Subscription period renewed',

  // Customers
  'customer.created': 'New customer was created',
  'customer.updated': 'Customer details updated',

  // Invitations
  'invitation.accepted': 'Team invitation was accepted',
  'invitation.expired': 'Team invitation expired',

  // API Keys
  'apikey.created': 'New API key was created',
  'apikey.revoked': 'API key was revoked',
} as const;
```

**Webhook payload format:**
```json
{
  "id": "evt_a1b2c3d4",
  "type": "subscription.created",
  "orgId": "org-uuid",
  "createdAt": "2026-08-08T10:00:00Z",
  "data": {
    "subscriptionId": "sub-uuid",
    "customerId": "cust-uuid",
    "planId": "plan-uuid",
    "status": "ACTIVE",
    "price": 49.99,
    "currency": "USD"
  }
}
```

**Signature verification (HMAC-SHA256):**
```typescript
// Webhook delivery Lambda signs each payload
import { createHmac } from 'crypto';

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// Headers sent to integrator:
// X-Anahata-Signature: sha256=abc123...
// X-Anahata-Webhook-Id: evt_a1b2c3d4
// X-Anahata-Timestamp: 1691500000
```

**SDK verification helper:**
```typescript
// In @anahata/billing-sdk
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  tolerance: number = 300 // 5 minutes
): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(`sha256=${expected}`));
}
```

**API Endpoints:**
```
POST   /apiv1/{orgId}/webhooks          → Register webhook
GET    /apiv1/{orgId}/webhooks          → List webhooks
GET    /apiv1/{orgId}/webhooks/{id}     → Get webhook details
PUT    /apiv1/{orgId}/webhooks/{id}     → Update webhook
DELETE /apiv1/{orgId}/webhooks/{id}     → Delete webhook
POST   /apiv1/{orgId}/webhooks/{id}/test → Send test event
```

**Delivery with retry (SQS + Dead Letter Queue):**
```typescript
// Retry schedule: 1min, 5min, 30min, 2hr, 12hr (5 attempts)
// After 5 failures → move to DLQ, mark webhook as FAILING
// After 3 consecutive days of failure → auto-disable webhook
```

**CDK Stack:**
```typescript
// src/cdk/stacks/WebhookStack.ts
export class WebhookStack extends AnahataCommonStack {
  constructor(scope: Construct, id: string, props: CommonStackProps) {
    super(scope, id, props);

    // DynamoDB table for webhook registrations
    const webhooksTable = new dynamodb.Table(this, 'WebhooksTable', {
      tableName: 'AnahataBillingWebhooks',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'webhookId', type: dynamodb.AttributeType.STRING },
    });

    // SQS queue for delivery
    const dlq = new sqs.Queue(this, 'WebhookDLQ', { queueName: 'billing-webhook-dlq' });
    const deliveryQueue = new sqs.Queue(this, 'WebhookDeliveryQueue', {
      queueName: 'billing-webhook-delivery',
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    // Delivery Lambda (processes SQS messages, calls integrator endpoints)
    const deliveryLambda = new lambda.Function(this, 'WebhookDeliveryLambda', {
      handler: 'webhook-delivery.handler',
      // ...
    });
    deliveryLambda.addEventSource(new SqsEventSource(deliveryQueue));
  }
}
```

---

### 2.3 API Versioning Strategy

**Goal:** Enable non-breaking evolution of the API with a clear deprecation path.

**Recommended approach: URL path versioning with sunset headers**

**Strategy:**
- Current APIs remain at `/apiv1/` (this becomes v1)
- Breaking changes get a new version: `/apiv2/`
- Non-breaking additions (new fields, new endpoints) go into the current version
- Deprecated endpoints return `Sunset` and `Deprecation` headers

**What counts as a breaking change:**
- Removing a field from a response
- Changing a field's type
- Renaming a field
- Changing required/optional status of request parameters
- Changing error response codes for existing scenarios
- Removing an endpoint

**What is NOT breaking:**
- Adding new optional fields to responses
- Adding new endpoints
- Adding new optional query parameters
- Adding new error codes for new scenarios

**Sunset headers on deprecated endpoints:**
```
Sunset: Sat, 01 Mar 2027 00:00:00 GMT
Deprecation: true
Link: <https://docs.anahata.ai/migration/v2>; rel="successor-version"
```

**Implementation:**
```typescript
// src/lambda/common/versioning.ts
export function addDeprecationHeaders(
  response: APIGatewayProxyResult,
  sunsetDate: string,
  migrationUrl: string
): APIGatewayProxyResult {
  return {
    ...response,
    headers: {
      ...response.headers,
      'Sunset': sunsetDate,
      'Deprecation': 'true',
      'Link': `<${migrationUrl}>; rel="successor-version"`,
    },
  };
}
```

**Changelog location:** `GET /apiv1/changelog` or hosted docs page.

---


## Tier 3: Differentiation (Week 7–14)

### 3.1 Embeddable UI Components

**Goal:** Provide drop-in JavaScript widgets that integrators embed in their websites — pricing table, checkout form, and customer portal.

**Package:** `@anahata/billing-widgets`

**Architecture:**
```
@anahata/billing-widgets/
├── src/
│   ├── pricing-table/        # Displays plans with pricing
│   ├── checkout/             # Subscribe form (email + plan selection)
│   ├── customer-portal/     # Manage subscription, cancel, upgrade
│   └── core/
│       ├── api.ts           # Uses public API with x-api-key
│       ├── styles.ts        # Scoped CSS (Shadow DOM)
│       └── config.ts        # Widget configuration
├── dist/
│   ├── anahata-billing.js   # UMD bundle (script tag)
│   ├── anahata-billing.esm.js  # ESM bundle (import)
│   └── anahata-billing.css  # Default styles
└── package.json
```

**Script tag integration:**
```html
<!-- Drop-in pricing table -->
<script src="https://cdn.anahata.ai/billing/v1/anahata-billing.js"></script>
<div id="pricing"></div>
<script>
  AnahataBilling.PricingTable({
    container: '#pricing',
    apiKey: 'bk_your_api_key',
    orgId: 'your-org-id',
    theme: {
      primaryColor: '#4f46e5',
      borderRadius: '8px',
    },
    onSubscribe: (result) => {
      console.log('Subscribed:', result.subscriptionId);
      window.location.href = '/welcome';
    },
  });
</script>
```

**React component integration:**
```tsx
import { PricingTable, CheckoutForm } from '@anahata/billing-widgets/react';

function PricingPage() {
  return (
    <PricingTable
      apiKey="bk_your_api_key"
      orgId="your-org-id"
      onSubscribe={(result) => router.push('/welcome')}
    />
  );
}
```

**Widget types:**

| Widget | Purpose | Public API Used |
|--------|---------|----------------|
| PricingTable | Display plans with pricing and features | GET /plans, GET /products |
| CheckoutForm | Collect email and subscribe to a plan | POST /subscribe |
| CustomerPortal | View/manage subscription, upgrade, cancel | Requires authenticated session |

**Implementation approach:**
- Use Web Components (Custom Elements + Shadow DOM) for framework agnosticism
- Ship framework-specific wrappers (React, Vue) as thin adapters
- Bundle with Vite for tree-shaking and small size
- Host on CloudFront CDN

**CDN delivery:**
```
https://cdn.anahata.ai/billing/v1/anahata-billing.js     (latest v1)
https://cdn.anahata.ai/billing/v1.2.0/anahata-billing.js (pinned version)
```

---

### 3.2 Customer Self-Service Portal

**Goal:** A hosted page (or embeddable widget) where end-customers can manage their own subscriptions without contacting the org's support team.

**Features:**
- View current subscription and plan details
- Upgrade or downgrade plan
- Cancel subscription
- Update billing email
- View subscription history

**Authentication:** The portal requires a short-lived customer session token:
```
POST /apiv1/public/{orgId}/customer-sessions
Body: { "email": "customer@example.com" }
→ Sends a magic link to customer's email
→ Magic link contains a signed JWT (valid 30 min)
```

**Portal URL:** `https://billing.anahata.ai/portal/{orgId}?token=eyJ...`

**CDK:** New stack for the portal (could be a static SPA on S3/CloudFront or a Lambda-rendered page).

---

### 3.3 Sandbox / Test Mode

**Goal:** Allow integrators to test their integration without creating real subscriptions or sending real emails.

**Implementation:**

1. **Test API keys** — Keys prefixed with `bk_test_` route to test mode:
   ```
   bk_live_a1b2c3...  → production data
   bk_test_a1b2c3...  → test data (separate table suffix or attribute flag)
   ```

2. **Test mode behavior:**
   - No emails are sent (SES calls are skipped)
   - Subscriptions are created with `testMode: true` flag
   - Trial expirations can be simulated instantly
   - Clock can be advanced for testing lifecycle events
   - Data is auto-purged after 30 days

3. **Test mode detection in Lambda:**
   ```typescript
   function isTestMode(apiKey: string): boolean {
     return apiKey.startsWith('bk_test_');
   }
   ```

4. **Test clock (for simulating time progression):**
   ```
   POST /apiv1/{orgId}/test/advance-clock
   Body: { "days": 15 }  // Advance time by 15 days for test subscriptions
   ```
   This triggers trial expiration, renewal, etc. for testing.

---

### 3.4 Usage Analytics Dashboard

**Goal:** Provide integrators with visibility into their API usage, subscription metrics, and integration health.

**Metrics to expose:**
- API calls per day/hour (by endpoint)
- Active subscriptions by plan
- New customers per period
- Churn rate (cancellations / active subscriptions)
- MRR (Monthly Recurring Revenue)
- Trial conversion rate
- Webhook delivery success rate

**Implementation:**

1. **Capture metrics** — Each Lambda logs structured metrics to CloudWatch:
   ```typescript
   // src/lambda/common/metrics.ts
   export function emitMetric(namespace: string, metric: string, value: number, dimensions: Record<string, string>) {
     console.log(JSON.stringify({
       _aws: {
         Timestamp: Date.now(),
         CloudWatchMetrics: [{
           Namespace: namespace,
           Dimensions: [Object.keys(dimensions)],
           Metrics: [{ Name: metric, Unit: 'Count' }],
         }],
       },
       [metric]: value,
       ...dimensions,
     }));
   }
   ```

2. **Aggregation** — Scheduled Lambda (daily) queries DynamoDB for subscription counts, calculates MRR, stores in a metrics table.

3. **API endpoint:**
   ```
   GET /apiv1/{orgId}/analytics/overview      → MRR, active subs, churn
   GET /apiv1/{orgId}/analytics/api-usage     → Call counts by endpoint
   GET /apiv1/{orgId}/analytics/subscriptions → Subscription metrics over time
   ```

4. **Dashboard UI** — Part of the billing admin frontend (separate project).

---


## Implementation Sequence

### Week 1
- [ ] Create `src/lambda/common/error-codes.ts` and `api-response.ts`
- [ ] Create `src/lambda/common/pagination.ts`
- [ ] Migrate `public-website-apis.ts` to use new error format + pagination
- [ ] Migrate `subscription-lifecycle.ts` to use new error format
- [ ] Add `GatewayResponse` for 429 with `Retry-After` header

### Week 2
- [ ] Add OpenAPI generation to `anahata-billing-model` Smithy build
- [ ] Create `/apiv1/docs` endpoint with Swagger UI
- [ ] Migrate remaining handlers to standardized error format
- [ ] Add pagination to generated list handlers via `copy-generated.js` patch

### Week 3–4
- [ ] Create `@anahata/billing-sdk` repository
- [ ] Generate TypeScript types from OpenAPI spec
- [ ] Implement client class with resource methods
- [ ] Add retry logic and auto-pagination
- [ ] Publish to CodeArtifact

### Week 5–6
- [ ] Create `WebhookStack` (DynamoDB table + SQS queue + delivery Lambda)
- [ ] Add webhook CRUD API endpoints
- [ ] Emit events from existing handlers (subscription.created, etc.)
- [ ] Implement HMAC signature and delivery retry logic
- [ ] Add `verifyWebhookSignature` to SDK
- [ ] Document versioning strategy and publish changelog format

### Week 7–10
- [ ] Build `@anahata/billing-widgets` — PricingTable component
- [ ] Build CheckoutForm component
- [ ] Set up CDN delivery (CloudFront + S3)
- [ ] Implement test mode (bk_test_ prefix detection, skip SES, test clock)

### Week 11–14
- [ ] Customer self-service portal (magic link auth + subscription management)
- [ ] Analytics aggregation Lambda + API endpoints
- [ ] Dashboard UI integration in billing admin frontend

---

## File Structure After Implementation

```
anahata-billing-apis/
├── src/
│   ├── cdk/
│   │   └── stacks/
│   │       ├── ... (existing)
│   │       ├── WebhookStack.ts         ← NEW
│   │       └── DocsStack.ts            ← NEW
│   ├── lambda/
│   │   ├── common/                     ← NEW (shared utilities)
│   │   │   ├── api-response.ts
│   │   │   ├── error-codes.ts
│   │   │   ├── pagination.ts
│   │   │   ├── versioning.ts
│   │   │   └── metrics.ts
│   │   ├── webhook-delivery.ts         ← NEW
│   │   ├── webhook-crud.ts             ← NEW
│   │   ├── analytics.ts               ← NEW
│   │   └── ... (existing handlers)
│   └── generated/
├── docs/
│   ├── openapi.json                    ← NEW (generated)
│   └── swagger-ui/                     ← NEW
└── scripts/

anahata-billing-sdk/                    ← NEW REPOSITORY
├── src/
│   ├── client.ts
│   ├── resources/
│   ├── types/
│   ├── errors.ts
│   └── utils/
└── package.json

anahata-billing-widgets/                ← NEW REPOSITORY
├── src/
│   ├── pricing-table/
│   ├── checkout/
│   └── customer-portal/
└── package.json
```

---

## Comparison: Before vs After

| Aspect | Before (Current) | After (Improved) |
|--------|-------------------|-------------------|
| Discovery | README only | OpenAPI spec + Swagger UI + SDK IntelliSense |
| Integration | Manual HTTP calls | Type-safe SDK with auto-retry |
| Error handling | Inconsistent format | Standardized codes + typed exceptions |
| Pagination | None (returns all) | Cursor-based with consistent envelope |
| Rate limits | Silent 429 | Headers + Retry-After + per-org limits |
| Real-time events | Poll manually | Webhooks with HMAC + retry + DLQ |
| Frontend integration | Build everything | Drop-in widgets (pricing table, checkout) |
| Testing | Hit production | Test mode with bk_test_ keys + test clock |
| Versioning | No strategy | Path-based with sunset headers |
| Monitoring | CloudWatch only | Analytics API + dashboard |

---

## References

- [Stripe API Design](https://stripe.com/docs/api) — Gold standard for billing API DX
- [OpenAPI 3.0 Specification](https://spec.openapis.org/oas/v3.0.3)
- [Smithy OpenAPI Plugin](https://smithy.io/2.0/guides/converting-to-openapi.html)
- [Webhook Best Practices (Svix)](https://docs.svix.com/overview)
- [API Versioning Strategies](https://www.postman.com/api-platform/api-versioning/)
