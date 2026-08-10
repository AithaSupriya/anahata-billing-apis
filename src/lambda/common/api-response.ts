/**
 * Standardized API response helpers for the Anahata Billing API.
 *
 * All Lambda handlers should use these functions to ensure consistent
 * response format across the entire API surface.
 */
import type { APIGatewayProxyResult } from 'aws-lambda';
import type { ErrorCode } from './error-codes.js';

// ── CORS Headers ──
export const CORS_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
};

// ── Error Types ──
export interface ApiErrorDetail {
  code: ErrorCode;
  message: string;
  target?: string;
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    target?: string;
    details?: ApiErrorDetail[];
    requestId?: string;
    timestamp: string;
  };
}

// ── Success Response ──
export function successResponse(
  statusCode: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, ...extraHeaders },
    body: JSON.stringify(data),
  };
}

// ── Error Response ──
export function errorResponse(
  statusCode: number,
  code: ErrorCode,
  message: string,
  options?: {
    target?: string;
    details?: ApiErrorDetail[];
    requestId?: string;
  },
): APIGatewayProxyResult {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      timestamp: new Date().toISOString(),
      ...(options?.target && { target: options.target }),
      ...(options?.details?.length && { details: options.details }),
      ...(options?.requestId && { requestId: options.requestId }),
    },
  };

  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

// ── Common Shorthand Helpers ──

export function badRequest(code: ErrorCode, message: string, target?: string): APIGatewayProxyResult {
  return errorResponse(400, code, message, { target });
}

export function unauthorized(code: ErrorCode, message: string): APIGatewayProxyResult {
  return errorResponse(401, code, message);
}

export function forbidden(code: ErrorCode, message: string): APIGatewayProxyResult {
  return errorResponse(403, code, message);
}

export function notFound(code: ErrorCode, message: string, target?: string): APIGatewayProxyResult {
  return errorResponse(404, code, message, { target });
}

export function conflict(code: ErrorCode, message: string): APIGatewayProxyResult {
  return errorResponse(409, code, message);
}

export function methodNotAllowed(): APIGatewayProxyResult {
  return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}

export function internalError(requestId?: string): APIGatewayProxyResult {
  return errorResponse(500, 'INTERNAL_ERROR', 'Internal server error', { requestId });
}

export function corsResponse(): APIGatewayProxyResult {
  return { statusCode: 200, headers: CORS_HEADERS, body: '' };
}
