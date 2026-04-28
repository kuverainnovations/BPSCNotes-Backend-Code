// ─────────────────────────────────────────────────────────────
// src/common/utils/response.util.ts
// ─────────────────────────────────────────────────────────────
export interface ApiResponse<T = any> {
  success:    boolean;
  message:    string;
  data?:      T;
  meta?:      PaginationMeta;
  timestamp:  string;
}

export interface PaginationMeta {
  total:       number;
  page:        number;
  limit:       number;
  totalPages:  number;
  hasNext:     boolean;
  hasPrev:     boolean;
}

export function successResponse<T>(
  data: T,
  message = 'Success',
  meta?: PaginationMeta,
): ApiResponse<T> {
  return {
    success:   true,
    message,
    data,
    ...(meta && { meta }),
    timestamp: new Date().toISOString(),
  };
}

export function paginationMeta(total: number, page: number, limit: number): PaginationMeta {
  const totalPages = Math.ceil(total / limit);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}
