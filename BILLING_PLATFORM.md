# Anahata Billing Platform — Complete Documentation

## 1. Platform Overview

The Anahata Billing Platform is a multi-tenant, serverless billing system built on AWS. It enables organizations to manage products, pricing plans, customers, subscriptions, team members, and API keys — all through a RESTful API secured by a dedicated authorization system.

The platform is designed as an independent service, separate from the core Anahata Aika product. It has its own authentication/authorization layer, its own DynamoDB tables, and its own deployment pipeline.

### Key Characteristics

- **Multi-tenant architecture** — Each organization (tenant) has isolated data, users, and configurations
- **Serverless** — Built entirely on AWS Lambda, API Gateway, DynamoDB, Cognito, and SES
- **Code-generated CRUD** — Base CRUD operations are auto-generated from a Smithy model; complex business logic is handled by custom Lambda handlers
- **Independent authorization** — A dedicated billing authorizer validates tokens and checks role-based permissions against billing-specific tables
- **Phased deployment** — Infrastructure was rolled out incrementally across multiple phases


---

## 2. Architecture

### Technology Stack

| Layer | Technology |
|-------|-----------|
| API Gateway | AWS API Gateway (REST) with custom domain |
| Compute | AWS Lambda (Node.js 22, ESM format) |
| Database | Amazon DynamoDB (multi-table design) |
| Authentication | AWS Cognito (shared user pool with Aika) |
| Authorization | Custom Lambda authorizer (role-based) |
| Email | Amazon SES (invitation emails) |
| DNS | Route53 (billing-api.sandbox.anahata.ai / billing-api.anahata.ai) |
| IaC | AWS CDK (TypeScript) with CodePipeline |
| Model | Smithy (code generation for CRUD) |
| Build | esbuild (ESM bundles), TypeScript |
| Registry | AWS CodeArtifact (@anahata scoped packages) |

### Infrastructure Stacks (14 total)

1. **DnsStack** — Route53 hosted zone for `billing-api.sandbox.anahata.ai`
2. **ServiceApiGatewayStack** — REST API, dedicated billing authorizer, custom domain, CORS
3. **CustomLambdasStack** — Custom Lambdas (org creation, invitation, subscription lifecycle)
4. **AnahataOrganizationStack** — Generated CRUD for organizations
5. **AnahataUserStack** — Generated CRUD for users/team members
6. **AnahataAccessRoleStack** — Generated CRUD for access roles
7. **AnahataInvitationStack** — Generated CRUD for invitations
8. **AnahataProductStack** — Generated CRUD for products
9. **AnahataPricingPlanStack** — Generated CRUD for pricing plans
10. **AnahataCustomerStack** — Generated CRUD for customers
11. **AnahataSubscriptionStack** — Generated CRUD for subscriptions
12. **AnahataApiKeyStack** — Generated CRUD for API keys
13. **PublicApisStack** — Unauthenticated endpoint (accept-invitation)
14. **PublicWebsiteApisStack** — Public website integration APIs (products, plans, subscribe)


### DynamoDB Tables

| Table Name | Partition Key | Sort Key | Purpose |
|-----------|--------------|----------|---------|
| BillingOrganizations | orgId | — | Tenant/organization records |
| BillingUsers | orgId | userId | Team members within each org |
| BillingAccessRoles | orgId | accessRoleId | Role definitions with action policies |
| BillingInvitations | orgId | invitationId | Team invitation records |
| AnahataBillingProducts | orgId | productId | Product catalog |
| AnahataBillingPricingPlans | orgId | planId | Pricing plan configurations |
| AnahataBillingCustomers | orgId | customerId | Customer records |
| AnahataBillingSubscriptions | orgId | subscriptionId | Subscription records |
| AnahataBillingApiKeys | orgId | apiKeyId | API keys for public endpoints |

**Global Secondary Indexes (GSIs):**
- `BillingUsers` → `userId-index` (for listing a user's organizations)
- `AnahataBillingApiKeys` → `keyValue-index` (for API key validation)
- `AnahataBillingCustomers` → `email-index` (for customer lookup by email)

---

## 3. Authentication & Authorization

### Authentication

The billing platform shares a Cognito User Pool with Anahata Aika but uses dedicated client IDs:
- **User Pool**: `us-east-2_utDR1Yzo8` (sandbox), `us-east-2_y58HO9kRD` (prod)
- **Client IDs**: `7psa52a6jaj4j4jgsbpibbvchm`, `a4nm2j561cl2fo7nhiohu0dki`

Users authenticate via Cognito (passwordless OTP or traditional flow) and receive JWT access tokens.


### Dedicated Billing Authorizer

The billing authorizer is a custom REQUEST-type Lambda authorizer that is completely independent of Anahata Aika. It validates tokens and checks permissions against billing-specific tables.

**Authorization Flow:**

```
1. Request arrives at API Gateway
   ↓
2. OPTIONS? → Allow (CORS preflight)
   ↓
3. No token? → Deny
   ↓
4. Verify Cognito JWT (access token, billing client IDs)
   ↓
5. Admin user? → Allow (bypass all checks)
   ↓
6. Open operation (create org, list orgs, get org)? → Allow for any authenticated user
   ↓
7. Org-scoped operation:
   a. Extract orgId from path parameter
   b. Query BillingUsers table (orgId + userId) for membership
   c. Not found? → Deny
   d. Get user's accessRoles array
   e. Batch-get role definitions from BillingAccessRoles
   f. Aggregate all actions across roles
   g. Check if required action matches user's allowed actions
   h. Match? → Allow | No match? → Deny
```

**Admin Users** (bypass all authorization):
- `sgannu.e@gmail.com`
- `yaswanthkrishna.nallapati@gmail.com`
- `info@anahata.ai`

**Open Operations** (any authenticated user):
- `POST /apiv1/orgs` — Create organization
- `GET /apiv1/orgs/list` — List user's organizations
- `GET /apiv1/orgs/{orgId}` — Get organization details

### Role-Based Access Control (RBAC)

Permissions are defined as `resource:operation` strings. Four default roles are created with every organization:

| Role | Actions |
|------|---------|
| **Owner** | `*:*` (full access) |
| **Admin** | products:read/write/delete, plans:read/write/delete, customers:read/write/delete, subscriptions:read/write/delete, users:read, invitations:read/write, organizations:read |
| **Manager** | products:read, plans:read, users:read, invitations:read, organizations:read |
| **Employee** | organizations:read |

**Wildcard matching:**
- `*:*` — matches any action
- `products:*` — matches any operation on products
- `products:read` — matches only read on products


---

## 4. Overall Billing Flow

### High-Level Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. ORGANIZATION SETUP                                              │
│     User signs up → Creates org → Gets Owner role                   │
│     Invites team members → They accept → Get assigned roles         │
├─────────────────────────────────────────────────────────────────────┤
│  2. PRODUCT & PLAN CONFIGURATION                                    │
│     Create products → Create pricing plans for each product         │
│     Plans define: price, interval (monthly/yearly/trial/one-time)   │
├─────────────────────────────────────────────────────────────────────┤
│  3. API KEY GENERATION                                              │
│     Create API keys for public website integration                  │
│     Keys auto-generated with "bk_" prefix                          │
├─────────────────────────────────────────────────────────────────────┤
│  4. CUSTOMER ACQUISITION                                            │
│     Public website calls POST /subscribe with email + planId        │
│     System creates/finds customer → Creates subscription            │
│     OR: Admin manually creates customer via authenticated API       │
├─────────────────────────────────────────────────────────────────────┤
│  5. SUBSCRIPTION LIFECYCLE                                          │
│     Create subscription (trial/free/paid)                           │
│     Upgrade or downgrade plan                                       │
│     Cancel subscription (immediate or end-of-period)                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Creating a Billing Setup (Step by Step)

### Step 1: Create an Organization

**Endpoint:** `POST /apiv1/orgs`

When a user creates an organization, a transactional write creates:
1. The organization record in `BillingOrganizations`
2. Four default access roles (Owner, Admin, Manager, Employee) in `BillingAccessRoles`
3. A Cognito user (if email provided and user doesn't exist)
4. The first user record in `BillingUsers` with the Owner role assigned

**Request body:**
```json
{
  "name": "Acme Corp",
  "description": "SaaS billing for Acme",
  "email": "admin@acme.com",
  "userEmail": "admin@acme.com",
  "userFirstName": "John",
  "userLastName": "Doe",
  "address": "123 Main St",
  "orgDomainUrls": ["acme.com"]
}
```

**Response:**
```json
{
  "orgId": "uuid",
  "name": "Acme Corp",
  "accessRoleId": "owner-role-uuid",
  "userId": "cognito-sub",
  "roles": [
    { "accessRoleId": "...", "name": "Owner" },
    { "accessRoleId": "...", "name": "Admin" },
    { "accessRoleId": "...", "name": "Manager" },
    { "accessRoleId": "...", "name": "Employee" }
  ]
}
```


### Step 2: Invite Team Members

**Endpoint:** `POST /apiv1/{orgId}/invitations`

Creates an invitation record, generates a unique code, and sends an HTML email via SES with an accept link.

**Request body:**
```json
{
  "email": "teammate@acme.com",
  "roleId": "admin-role-uuid",
  "orgName": "Acme Corp",
  "inviterName": "John Doe"
}
```

**What happens:**
1. Invitation stored in `BillingInvitations` with status `PENDING`
2. Expiry set to 7 days
3. HTML email sent via SES with an "Accept Invitation" button
4. Link format: `{FRONTEND_URL}/accept-invite?code={invitationId}&email={email}&orgId={orgId}`

### Step 3: Accept Invitation (Public endpoint)

**Endpoint:** `POST /apiv1/public/accept-invitation`

No authentication required. The invitee provides their details and the invitation code.

**Request body:**
```json
{
  "invitationCode": "uuid",
  "orgId": "org-uuid",
  "email": "teammate@acme.com",
  "password": "SecureP@ss123!",
  "firstName": "Jane",
  "lastName": "Smith"
}
```

**What happens:**
1. Validates invitation code exists and is `PENDING`
2. Checks expiration (marks as `EXPIRED` if past due)
3. Creates Cognito user with permanent password
4. Creates `BillingUsers` record with assigned roles from the invitation
5. Updates invitation status to `ACCEPTED`

### Step 4: Create Products

**Endpoint:** `POST /apiv1/{orgId}/products` (generated CRUD)

Products represent what the organization sells. Each product can have multiple pricing plans.

**Typical product fields:**
```json
{
  "name": "Pro Plan",
  "description": "Full-featured plan for growing teams",
  "status": "ACTIVE",
  "metadata": {}
}
```

### Step 5: Create Pricing Plans

**Endpoint:** `POST /apiv1/{orgId}/plans` (generated CRUD)

Plans define the pricing and billing interval for a product.

**Typical plan fields:**
```json
{
  "productId": "product-uuid",
  "name": "Pro Monthly",
  "price": 49.99,
  "currency": "USD",
  "billingInterval": "MONTHLY",
  "trialDays": 14,
  "status": "ACTIVE",
  "features": ["Feature A", "Feature B"]
}
```

**Billing intervals supported:**
- `MONTHLY` — Renews every month
- `YEARLY` — Renews every 12 months
- `ONE_TIME` — Single payment (effectively 10-year period)
- `TRIAL` — Free trial period (default 14 days, overridden by `trialDays`)


### Step 6: Create API Keys

**Endpoint:** `POST /apiv1/{orgId}/api-keys` (generated CRUD, patched)

API keys are used to authenticate public website requests (product listing, plan listing, subscriptions from customer-facing websites).

**Auto-generated key format:** `bk_` + 48 random hex characters (e.g., `bk_a1b2c3d4e5f6...`)

**Fields:**
```json
{
  "name": "Production Website Key",
  "status": "ACTIVE",
  "keyValue": "bk_a1b2c3..." // auto-generated on create
}
```

### Step 7: Manage Customers

**Endpoint:** `CRUD /apiv1/{orgId}/customers` (generated + public subscribe)

Customers can be created in two ways:
1. **Admin API** — Authenticated users manually create customers via the CRUD API
2. **Public subscribe** — Automatically created when a visitor subscribes on a public website

### Step 8: Create Subscriptions

**Endpoint:** `POST /apiv1/{orgId}/subscriptions` (custom handler)

The subscription lifecycle handler manages creation, upgrades/downgrades, and cancellation.

**Create subscription request:**
```json
{
  "customerId": "customer-uuid",
  "planId": "plan-uuid",
  "autoRenew": true,
  "metadata": {}
}
```

**What happens on creation:**
1. Validates customer exists in `AnahataBillingCustomers`
2. Validates plan exists in `AnahataBillingPricingPlans`
3. Determines initial status based on plan type:
   - Plan has `trialDays > 0` or `billingInterval = TRIAL` → status = `FREE_TRIAL`
   - Plan `price = 0` → status = `ACTIVE` (free plan)
   - Plan `price > 0` → status = `ACTIVE` (payment handling deferred to Phase 8)
4. Calculates `currentPeriodStart` and `currentPeriodEnd`
5. Stores subscription in `AnahataBillingSubscriptions`

---

## 6. Subscription Lifecycle

### Subscription Statuses

| Status | Meaning |
|--------|---------|
| `FREE_TRIAL` | Customer is in a trial period |
| `ACTIVE` | Subscription is active (free or paid) |
| `CANCELLED` | Subscription has been cancelled |

### Upgrade/Downgrade

**Endpoint:** `PUT /apiv1/{orgId}/subscriptions/{subscriptionId}`

```json
{
  "planId": "new-plan-uuid",
  "updatedAt": 1234567890  // optimistic locking
}
```

**Behavior:**
- Validates subscription exists and is not `CANCELLED`
- Validates new plan exists
- Uses optimistic locking (client must send current `updatedAt` value)
- Updates plan, price, currency, and billing interval
- Records `previousPlanId` for audit trail
- Takes effect immediately (no proration — deferred to future phase)

### Cancel Subscription

**Endpoint:** `DELETE /apiv1/{orgId}/subscriptions/{subscriptionId}`

```json
{
  "immediate": true,
  "cancelReason": "No longer needed"
}
```

**Behavior:**
- If `immediate: true` (default) — cancels immediately
- If `immediate: false` — marks for cancellation at end of current period
- Sets status to `CANCELLED`, records `cancelledAt` and `cancelReason`


---

## 7. Public Website Integration

The platform provides unauthenticated public APIs for embedding billing features into customer-facing websites. These endpoints are validated by `x-api-key` header (not Bearer tokens).

### Available Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /apiv1/public/{orgId}/products | List active products |
| GET | /apiv1/public/{orgId}/plans | List active plans (optional `?productId` filter) |
| GET | /apiv1/public/{orgId}/plans/{planId} | Get plan details |
| POST | /apiv1/public/{orgId}/subscribe | Subscribe a customer |

### Public Subscribe Flow

```
Customer visits pricing page → Website fetches plans via GET /plans
   ↓
Customer selects a plan and enters email
   ↓
Website calls POST /subscribe with { email, planId, name }
   ↓
System validates API key (x-api-key header)
   ↓
System validates plan exists and is ACTIVE
   ↓
System finds existing customer by email OR creates new customer
   ↓
System creates subscription (FREE_TRIAL or ACTIVE based on plan)
   ↓
Returns { customerId, subscriptionId, status, planName, trialEnd? }
```

---

## 8. Build & Deployment Pipeline

### Build Process

```bash
npm run build
```

Executes:
1. **`copy-generated`** — Copies generated CDK stacks and Lambda handlers from `anahata-billing-model` into `src/generated/`. Applies patches:
   - Converts existing table creation to `Table.fromTableName()` (import mode)
   - Removes GSI additions for imported tables
   - Fixes import paths (`@anahata/service-model` → `@anahata/billing-model`)
   - Adds auto-generated `keyValue` for API keys
2. **`tsc`** — TypeScript compilation
3. **`esbuild`** — Bundles each Lambda handler individually (ESM, Node 20 target, AWS SDK externalized)
4. **`postbuild:copy`** — Copies `package.json` with `"type": "module"` to Lambda dist directories

### Deployment

Deployed via AWS CodePipeline:
- **Source**: GitHub repository `anahata-ai/anahata-billing-apis`
- **Build**: CodeBuild with CodeArtifact authentication for `@anahata` scoped packages
- **Deploy**: CDK synth + deploy to sandbox and production

**Manual deployment:**
```bash
# Deploy all sandbox stacks
npx cdk deploy "*-sandbox" --require-approval never

# Create API Gateway deployment (activates latest config)
aws apigateway create-deployment --rest-api-id gx8hh1qzvb --stage-name sandbox --region us-east-2
```

### Environments

| Environment | API URL | Account |
|------------|---------|---------|
| Sandbox | `https://gx8hh1qzvb.execute-api.us-east-2.amazonaws.com/sandbox` | 689327566109 |
| Production | `https://billing-api.anahata.ai` | 689327566109 |


---

## 9. API Reference

### Authenticated Endpoints (Bearer token)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | /apiv1/orgs | custom-org-creation | Create organization (transactional) |
| GET | /apiv1/orgs/list | custom-org-creation | List user's organizations |
| DELETE | /apiv1/orgs/{orgId} | custom-org-creation | Delete organization (soft) |
| GET/PUT | /apiv1/orgs/{orgId} | generated | Get/update organization |
| CRUD | /apiv1/{orgId}/users | generated | Manage team members |
| CRUD | /apiv1/{orgId}/roles | generated | Manage access roles |
| POST/GET | /apiv1/{orgId}/invitations | custom-invitation | Create/list invitations |
| CRUD | /apiv1/{orgId}/products | generated | Manage products |
| CRUD | /apiv1/{orgId}/plans | generated | Manage pricing plans |
| CRUD | /apiv1/{orgId}/customers | generated | Manage customers |
| POST | /apiv1/{orgId}/subscriptions | subscription-lifecycle | Create subscription |
| PUT | /apiv1/{orgId}/subscriptions/{subId} | subscription-lifecycle | Upgrade/downgrade |
| DELETE | /apiv1/{orgId}/subscriptions/{subId} | subscription-lifecycle | Cancel subscription |
| CRUD | /apiv1/{orgId}/api-keys | generated | Manage API keys |

### Public Endpoints (x-api-key header)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | /apiv1/public/{orgId}/products | public-website-apis | List active products |
| GET | /apiv1/public/{orgId}/plans | public-website-apis | List active plans |
| GET | /apiv1/public/{orgId}/plans/{planId} | public-website-apis | Get plan details |
| POST | /apiv1/public/{orgId}/subscribe | public-website-apis | Subscribe customer |

### Unauthenticated Endpoints

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | /apiv1/public/accept-invitation | accept-invitation | Accept team invitation |
| GET | /health | mock integration | Health check |

---

## 10. What Has Been Implemented So Far

### Phase 1: Foundation (Completed)
- DNS and custom domain setup (`billing-api.sandbox.anahata.ai`)
- API Gateway with dedicated billing authorizer
- Organization CRUD (custom transactional handler)
- User management (generated CRUD)
- Access roles (generated CRUD + 4 default roles on org creation)
- Team invitations (custom handler + SES email + accept flow)
- Cognito integration (user creation on org create and invitation accept)

### Phase 2: Products & Plans (Completed)
- Products CRUD (generated from Smithy model)
- Pricing Plans CRUD (generated from Smithy model)
- Support for MONTHLY, YEARLY, ONE_TIME, and TRIAL billing intervals

### Phase 3: Customers & Subscriptions (Completed)
- Customers CRUD (generated)
- Subscription lifecycle handler (custom):
  - Create with trial/free/paid logic
  - Upgrade/downgrade with optimistic locking
  - Cancel (immediate or end-of-period)

### Phase 4: API Keys & Public APIs (Completed)
- API Keys CRUD with auto-generated `bk_` prefix values
- Public website APIs (list products, plans, get plan, subscribe)
- API key validation via GSI lookup
- Public subscribe flow (find-or-create customer + create subscription)

### Phase 5: Build & Pipeline (Completed)
- CodePipeline for automated deployments
- CodeArtifact integration for `@anahata` packages
- `copy-generated` script with table import mode patching
- esbuild bundling (ESM, individual handlers)
- Multi-environment support (sandbox + production)


### Not Yet Implemented

- **Payment processing** (Stripe integration) — noted as "Phase 8" in the codebase. Currently, paid subscriptions are set to `ACTIVE` without actual payment collection.
- **Proration logic** — upgrades/downgrades take effect immediately without prorating charges
- **Invoice generation** — no invoices are generated
- **Usage-based billing** — not yet supported
- **Subscription auto-renewal** — `autoRenew` flag is stored but no cron/scheduler processes renewals
- **Trial expiration handling** — no automated transition from `FREE_TRIAL` to `ACTIVE` or `EXPIRED`
- **Webhook notifications** — no event-driven notifications on subscription changes

---

## 11. Key Design Decisions

1. **Dedicated billing authorizer** — Independent from Anahata Aika's authorization. Uses its own DynamoDB tables (`BillingUsers`, `BillingAccessRoles`) so billing permissions are fully decoupled from the main product.

2. **Table import mode** — Tables created in earlier deploys (Phase 1) use `RemovalPolicy.RETAIN`. The `copy-generated` script patches subsequent deploys to use `Table.fromTableName()` to avoid CloudFormation conflicts.

3. **Code generation + custom handlers** — Base CRUD is generated from a Smithy model for consistency and speed. Complex multi-step operations (org creation, invitations, subscriptions) use custom Lambda handlers.

4. **ESM Lambda format** — All handlers are bundled as ESM with a `createRequire` banner for compatibility. AWS SDK v3 is externalized (provided by Lambda runtime).

5. **Multi-tenant data isolation** — Every DynamoDB table uses `orgId` as the partition key, ensuring data is naturally scoped to each organization.

6. **Optimistic locking** — Subscription updates require the client to send the current `updatedAt` timestamp to prevent concurrent modification conflicts.

7. **Non-blocking email** — Invitation emails are sent via SES but failures don't block the invitation creation. The invitation record is created regardless.

8. **Public API key validation** — Public endpoints use a custom `x-api-key` header validated against the `AnahataBillingApiKeys` table (GSI on `keyValue`), not API Gateway's built-in API key feature.

---

## 12. Project Dependencies

### Runtime
- `@anahata/cdk-commons` — Shared CDK constructs (AnahataCommonStack, CodePipelineStack, environment configs)
- `@anahata/billing-model` — Smithy model + generated code (CDK stacks, Lambda handlers)
- `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` — DynamoDB access
- `@aws-sdk/client-cognito-identity-provider` — Cognito user management
- `@aws-sdk/client-ses` — Email sending
- `aws-jwt-verify` — Cognito JWT token verification
- `aws-cdk-lib` + `constructs` — CDK infrastructure

### Related Repositories
- `anahata-billing-model` — Smithy model definitions, generates CRUD stacks and handlers
- `anahata-cdk-commons` — Shared CDK utilities (pipeline, environments, certificates)
- `anahata-authn-authz` — Cognito user pool, passwordless auth triggers, authorization service

---

## 13. Environments & Configuration

### Sandbox
- **API Gateway ID**: `gx8hh1qzvb`
- **Stage**: `sandbox`
- **Region**: `us-east-2`
- **Cognito User Pool**: `us-east-2_utDR1Yzo8`
- **Domain**: `billing-api.sandbox.anahata.ai`
- **Frontend URL** (for invitation links): `http://localhost:5173`
- **From Email**: `supriya.a.visys@gmail.com`

### Production
- **Stage**: `prod`
- **Cognito User Pool**: `us-east-2_y58HO9kRD`
- **Domain**: `billing-api.anahata.ai`
- **Frontend URL**: `https://billing.anahata.ai`
