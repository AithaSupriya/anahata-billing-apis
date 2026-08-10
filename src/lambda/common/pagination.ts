/**
 * Cursor-based pagination utilities for the Anahata Billing API.
 *
 * Provides consistent pagination across all list endpoints using
 * DynamoDB's LastEvaluatedKey as an opaque base64url-encoded cursor.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

// ── Types ──

export interface PaginationParams {
  /** Number of items to return (1–100, default 20) */
  limit: number;
  /** Decoded DynamoDB ExclusiveStartKey for continuation */
  cursor?: Record<string, unknown>;
}

export interface PaginationMeta {
  /** Number of items in this page */
  count: number;
  /** Requested limit */
  limit: number;
  /** Whether more items exist beyond this page */
  hasMore: boolean;
  /** Opaque cursor for the next page (omitted if no more items) */
  nextCursor?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: PaginationMeta;
}

// ── Parse Pagination from Request ──

/**
 * Extracts pagination parameters from query string.
 *
 * Query params:
 *   - limit: number (1–100, default 20)
 *   - cursor: base64url-encoded opaque cursor from previous response
 */
export function parsePaginationParams(event: APIGatewayProxyEvent): PaginationParams {
  const rawLimit = event.queryStringParameters?.limit;
  const limit = Math.min(Math.max(parseInt(rawLimit || '20', 10) || 20, 1), 100);

  let cursor: Record<string, unknown> | undefined;
  const rawCursor = event.queryStringParameters?.cursor;

  if (rawCursor) {
    try {
      const decoded = Buffer.from(rawCursor, 'base64url').toString('utf-8');
      cursor = JSON.parse(decoded);
    } catch {
      // Invalid cursor — ignore and start from beginning
      cursor = undefined;
    }
  }

  return { limit, cursor };
}

// ── Build Paginated Response ──

/**
 * Wraps a list of items with pagination metadata.
 *
 * @param items - The items for this page
 * @param limit - The requested limit
 * @param lastEvaluatedKey - DynamoDB's LastEvaluatedKey (undefined if no more pages)
 */
export function buildPaginatedResponse<T>(
  items: T[],
  limit: number,
  lastEvaluatedKey?: Record<string, unknown>,
): PaginatedResponse<T> {
  const hasMore = !!lastEvaluatedKey;

  let nextCursor: string | undefined;
  if (lastEvaluatedKey) {
    nextCursor = Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf-8').toString('base64url');
  }

  return {
    items,
    pagination: {
      count: items.length,
      limit,
      hasMore,
      ...(nextCursor && { nextCursor }),
    },
  };
}
