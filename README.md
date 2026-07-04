# Anahata Billing APIs

CDK infrastructure and Lambda handlers for the Anahata Billing Platform.

## Architecture

- **CDK Stacks** — API Gateway, DynamoDB tables, Lambda functions, IAM roles
- **Custom Lambdas** — Organization creation, invitation handling, subscription lifecycle, public website APIs, billing authorizer
- **Generated Lambdas** — Auto-generated CRUD handlers from Smithy models (products, plans, customers, users, roles, api-keys)

## Prerequisites

- Node.js 22+
- AWS CLI configured with `us-east-2` region
- Access to AWS account `689327566109` (sandbox)
- Local `anahata-billing-model` and `anahata-cdk-commons` repositories

## Setup

```bash
npm install
```

## Build

```bash
npm run build
```

This runs:
1. `copy-generated` — Copies generated CDK stacks and Lambda handlers from `anahata-billing-model`
2. `tsc` — Compiles TypeScript
3. `esbuild` — Bundles Lambda handlers (ESM format)
4. `postbuild:copy` — Copies `package.json` with `"type": "module"` to Lambda dirs

## Deploy (Sandbox)

```bash
# Deploy all sandbox stacks
npx cdk deploy "*-sandbox" --require-approval never

# Create API Gateway deployment (activates latest config)
aws apigateway create-deployment --rest-api-id gx8hh1qzvb --stage-name sandbox --region us-east-2
```

## Project Structure

```
src/
├── cdk/
│   ├── App.ts                      # CDK entry point + pipeline
│   └── stacks/
│       ├── ServiceApiGatewayStack.ts   # API Gateway + billing authorizer
│       ├── CustomLambdasStack.ts       # Custom Lambda functions
│       ├── PublicApisStack.ts          # Accept invitation endpoint
│       ├── PublicWebsiteApisStack.ts   # Public website integration APIs
│       └── DnsStack.ts                 # DNS/domain configuration
├── lambda/
│   ├── billing-authorizer.ts       # Dedicated billing authorizer
│   ├── custom-org-creation.ts      # Org creation + list orgs
│   ├── custom-invitation.ts        # Team invitation + SES email
│   ├── accept-invitation.ts        # Accept invitation (public)
│   ├── subscription-lifecycle.ts   # Subscription create/upgrade/cancel
│   └── public-website-apis.ts      # Public APIs (products, plans, subscribe)
├── generated/
│   ├── cdk/                        # Generated CDK stacks (from Smithy)
│   └── lambda/                     # Generated CRUD handlers
scripts/
└── copy-generated.js               # Copies + patches generated code
```

## API Endpoints

### Authenticated (Bearer token)
| Method | Path | Description |
|--------|------|-------------|
| POST | /apiv1/orgs | Create organization |
| GET | /apiv1/orgs/list | List user's organizations |
| GET/PUT | /apiv1/orgs/{orgId} | Get/update organization |
| CRUD | /apiv1/{orgId}/users | Team members |
| CRUD | /apiv1/{orgId}/roles | Access roles |
| POST/GET | /apiv1/{orgId}/invitations | Invitations |
| CRUD | /apiv1/{orgId}/products | Products |
| CRUD | /apiv1/{orgId}/plans | Pricing plans |
| CRUD | /apiv1/{orgId}/customers | Customers |
| CRUD | /apiv1/{orgId}/subscriptions | Subscriptions |
| CRUD | /apiv1/{orgId}/api-keys | API keys |

### Public (x-api-key header)
| Method | Path | Description |
|--------|------|-------------|
| GET | /apiv1/public/{orgId}/products | List active products |
| GET | /apiv1/public/{orgId}/plans | List active plans |
| GET | /apiv1/public/{orgId}/plans/{planId} | Get plan details |
| POST | /apiv1/public/{orgId}/subscribe | Subscribe customer |

### Unauthenticated
| Method | Path | Description |
|--------|------|-------------|
| POST | /apiv1/public/accept-invitation | Accept team invitation |

## Environment

- **Sandbox API**: `https://gx8hh1qzvb.execute-api.us-east-2.amazonaws.com/sandbox`
- **Cognito User Pool**: `us-east-2_utDR1Yzo8`
- **AWS Account**: `689327566109`

## Key Design Decisions

- **Dedicated billing authorizer** — Independent from Anahata Aika. Queries `BillingUsers` and `BillingAccessRoles` tables.
- **Table import mode** — Generated stacks use `Table.fromTableName()` for existing tables to prevent CloudFormation conflicts.
- **Import path patching** — `copy-generated.js` patches `@anahata/service-model` → `@anahata/billing-model` in generated handlers.
- **ESM Lambda format** — All handlers bundled as ESM with `"type": "module"` in deployment directory.
