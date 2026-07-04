/**
 * Custom Invitation Handler
 *
 * Handles: POST /apiv1/{orgId}/invitations
 *
 * Creates an invitation record in BillingInvitations, generates
 * a unique invitation code, sets expiry date, and sends invitation email via SES.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({});
const INVITATIONS_TABLE = process.env.INVITATIONS_TABLE_NAME || 'BillingInvitations';
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@anahata.ai';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://billing.sandbox.anahata.ai';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

async function sendInvitationEmail(
  toEmail: string,
  invitationId: string,
  orgId: string,
  orgName: string,
  inviterName: string,
): Promise<boolean> {
  const acceptUrl = `${FRONTEND_URL}/accept-invite?code=${invitationId}&email=${encodeURIComponent(toEmail)}&orgId=${orgId}`;

  try {
    await ses.send(new SendEmailCommand({
      Source: FROM_EMAIL,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: `You've been invited to join ${orgName} on Anahata Billing` },
        Body: {
          Html: {
            Data: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
                <h2 style="color: #1f2937; margin-bottom: 8px;">You're invited!</h2>
                <p style="color: #4b5563; line-height: 1.6;">
                  <strong>${inviterName || 'A team member'}</strong> has invited you to join <strong>${orgName}</strong> on Anahata Billing.
                </p>
                <div style="margin: 32px 0;">
                  <a href="${acceptUrl}" style="display: inline-block; background-color: #4f46e5; color: white; font-weight: 600; text-decoration: none; padding: 12px 24px; border-radius: 8px;">
                    Accept Invitation
                  </a>
                </div>
                <p style="color: #6b7280; font-size: 14px;">
                  Or copy this link: <a href="${acceptUrl}" style="color: #4f46e5;">${acceptUrl}</a>
                </p>
                <p style="color: #9ca3af; font-size: 12px; margin-top: 32px;">
                  This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
                </p>
              </div>
            `,
          },
          Text: {
            Data: `You've been invited to join ${orgName} on Anahata Billing.\n\nAccept your invitation: ${acceptUrl}\n\nThis invitation expires in 7 days.`,
          },
        },
      },
    }));
    console.log(`[INVITATION] Email sent to ${toEmail}`);
    return true;
  } catch (err: any) {
    // SES might not be configured or email not verified — log but don't fail
    console.warn(`[INVITATION] Email sending failed (non-blocking): ${err.message}`);
    return false;
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('[INVITATION] Event:', JSON.stringify({
    method: event.httpMethod,
    path: event.path,
    resource: event.resource,
  }));

  try {
    if (event.httpMethod === 'OPTIONS') return respond(200, {});

    if (event.httpMethod !== 'POST') {
      return respond(405, { error: 'Method not allowed' });
    }

    const orgId = event.pathParameters?.orgId;
    if (!orgId) {
      return respond(400, { error: 'orgId is required' });
    }

    let body: any;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return respond(400, { error: 'Invalid JSON in request body' });
    }

    // Validate required fields
    const { email, roleId, message } = body;

    if (!email || typeof email !== 'string') {
      return respond(400, { error: 'email is required' });
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return respond(400, { error: 'Invalid email format' });
    }

    if (!roleId || typeof roleId !== 'string') {
      return respond(400, { error: 'roleId is required' });
    }

    const now = new Date();
    const invitationId = randomUUID();
    const invitationCode = randomUUID(); // Separate code for the email link
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    const invitedBy = event.requestContext?.authorizer?.userId || 'system';

    const item = {
      orgId,
      invitationId,
      invitationCode,
      email: email.trim().toLowerCase(),
      roleId,
      message: message || '',
      status: 'PENDING',
      invitedBy,
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: Date.now(),
    };

    await ddb.send(new PutCommand({
      TableName: INVITATIONS_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(invitationId)',
    }));

    console.log(`[INVITATION] Created: invitationId=${invitationId} email=${email} orgId=${orgId}`);

    // Send invitation email (non-blocking — if SES fails, invitation is still created)
    const emailSent = await sendInvitationEmail(
      email.trim().toLowerCase(),
      invitationId,
      orgId,
      body.orgName || 'your organization',
      body.inviterName || '',
    );

    return respond(201, {
      invitationId,
      orgId,
      email: item.email,
      roleId,
      invitationCode,
      status: 'PENDING',
      invitedBy,
      expiresAt,
      createdAt: item.createdAt,
      emailSent,
    });
  } catch (error: any) {
    console.error('[INVITATION] Error:', error);
    return respond(500, { error: error.message || 'Internal server error' });
  }
};
