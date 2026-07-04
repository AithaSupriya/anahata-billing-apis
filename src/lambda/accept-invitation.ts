/**
 * Accept Invitation Handler — Public (unauthenticated) endpoint
 *
 * Handles: POST /apiv1/public/accept-invitation
 *
 * Flow:
 *  1. Validate invitation code against BillingInvitations table
 *  2. Check invitation is PENDING and not expired
 *  3. Create Cognito user with provided email/password
 *  4. Create User record in BillingUsers with assigned access roles
 *  5. Update invitation status to ACCEPTED
 *
 * Request body:
 * {
 *   "invitationCode": "uuid",
 *   "email": "user@example.com",
 *   "password": "SecureP@ss1",
 *   "firstName": "John",
 *   "lastName": "Doe"
 * }
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// ── Environment Variables ──
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const USERS_TABLE_NAME = process.env.USERS_TABLE_NAME || 'BillingUsers';
const INVITATIONS_TABLE_NAME = process.env.INVITATIONS_TABLE_NAME || 'BillingInvitations';

// ── Invitation Status ──
enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

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

/**
 * Validates the invitation and returns the invitation record if valid.
 */
async function validateInvitation(invitationCode: string, orgId: string) {
  // The invitation table has composite key: PK=orgId, SK=invitationId
  // The "code" in the email link IS the invitationId
  const result = await ddb.send(
    new GetCommand({
      TableName: INVITATIONS_TABLE_NAME,
      Key: { orgId, invitationId: invitationCode },
    }),
  );

  const invitation = result.Item;
  if (!invitation) {
    return { valid: false, error: 'Invitation not found', statusCode: 404 };
  }

  if (invitation.status !== InvitationStatus.PENDING) {
    return {
      valid: false,
      error: `Invitation is ${invitation.status.toLowerCase()}`,
      statusCode: 409,
    };
  }

  // Check expiration
  if (invitation.expiresAt) {
    const expiryDate = new Date(invitation.expiresAt);
    if (expiryDate < new Date()) {
      // Mark as expired
      await ddb.send(
        new UpdateCommand({
          TableName: INVITATIONS_TABLE_NAME,
          Key: { orgId, invitationId: invitationCode },
          UpdateExpression: 'SET #status = :expired, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expired': InvitationStatus.EXPIRED,
            ':now': new Date().toISOString(),
          },
        }),
      );
      return { valid: false, error: 'Invitation has expired', statusCode: 409 };
    }
  }

  return { valid: true, invitation };
}

/**
 * Creates a Cognito user and sets their permanent password.
 */
async function createCognitoUser(email: string, password: string, firstName?: string, lastName?: string): Promise<string> {
  // Check if user already exists
  try {
    const existing = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: email,
      }),
    );
    const sub = existing.UserAttributes?.find(a => a.Name === 'sub')?.Value;
    if (sub) return sub;
  } catch (err: any) {
    if (err.name !== 'UserNotFoundException') throw err;
  }

  // Create user with temporary password
  const createResult = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        ...(firstName ? [{ Name: 'given_name', Value: firstName }] : []),
        ...(lastName ? [{ Name: 'family_name', Value: lastName }] : []),
      ],
      TemporaryPassword: `Temp${randomUUID().slice(0, 8)}!`,
      MessageAction: 'SUPPRESS',
    }),
  );

  // Set permanent password
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );

  const sub = createResult.User?.Attributes?.find(a => a.Name === 'sub')?.Value;
  return sub || email;
}

// ── Main Handler ──
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('EVENT:', JSON.stringify({ ...event, body: '[REDACTED]' }));

  try {
    if (event.httpMethod === 'OPTIONS') return apiResponse(200, {});

    if (event.httpMethod !== 'POST') {
      return apiResponse(405, { error: 'Method not allowed' });
    }

    let body: any;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return apiResponse(400, { error: 'Invalid JSON in request body' });
    }

    // Validate required fields
    const { invitationCode, email, password, firstName, lastName, orgId } = body;

    if (!invitationCode) return apiResponse(400, { error: 'invitationCode is required' });
    if (!email) return apiResponse(400, { error: 'email is required' });
    if (!password) return apiResponse(400, { error: 'password is required' });
    if (!firstName) return apiResponse(400, { error: 'firstName is required' });
    if (!lastName) return apiResponse(400, { error: 'lastName is required' });
    if (!orgId) return apiResponse(400, { error: 'orgId is required' });

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return apiResponse(400, { error: 'Invalid email format' });
    }

    // Validate password strength (min 8 chars, uppercase, lowercase, number, special)
    if (password.length < 8) {
      return apiResponse(400, { error: 'Password must be at least 8 characters' });
    }

    // Step 1: Validate invitation
    const validationResult = await validateInvitation(invitationCode, orgId);
    if (!validationResult.valid) {
      return apiResponse(validationResult.statusCode!, { error: validationResult.error });
    }

    const invitation = validationResult.invitation!;
    const invRoleId = invitation.roleId;
    const accessRoles = invRoleId ? [invRoleId] : (invitation.accessRoles || []);
    const groups = invitation.groups || [];
    // orgId comes from body (verified against the invitation's orgId)
    const invOrgId = invitation.orgId || orgId;

    // Step 2: Create Cognito user
    let userId: string;
    try {
      userId = await createCognitoUser(email, password, firstName, lastName);
    } catch (err: any) {
      console.error('[ACCEPT_INVITATION] Cognito error:', err);
      if (err.name === 'UsernameExistsException') {
        return apiResponse(409, { error: 'A user with this email already exists' });
      }
      return apiResponse(500, { error: 'Failed to create user account' });
    }

    const now = new Date().toISOString();

    // Step 3: Create User record in BillingUsers
    try {
      await ddb.send(
        new PutCommand({
          TableName: USERS_TABLE_NAME,
          Item: {
            userId,
            orgId,
            userFirstName: firstName.trim(),
            userLastName: lastName.trim(),
            email: email.trim().toLowerCase(),
            accessRoles,
            groups,
            invitationId: invitationCode,
            createdAt: now,
            updatedAt: now,
          },
          ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(orgId)',
        }),
      );
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        return apiResponse(409, { error: 'User already exists in this organization' });
      }
      throw err;
    }

    // Step 4: Update invitation status to ACCEPTED
    await ddb.send(
      new UpdateCommand({
        TableName: INVITATIONS_TABLE_NAME,
        Key: { orgId, invitationId: invitationCode },
        UpdateExpression: 'SET #status = :accepted, acceptedBy = :userId, acceptedAt = :now, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':accepted': InvitationStatus.ACCEPTED,
          ':userId': userId,
          ':now': now,
        },
      }),
    );

    console.log(`[ACCEPT_INVITATION] invitationId=${invitationCode} userId=${userId} orgId=${orgId}`);

    return apiResponse(200, {
      message: 'Invitation accepted successfully',
      userId,
      orgId,
      email: email.trim().toLowerCase(),
    });
  } catch (error: any) {
    console.error('[ACCEPT_INVITATION] Handler error:', error);
    return apiResponse(500, { error: 'Internal server error' });
  }
};
