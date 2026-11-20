// Every failure the API returns is an AppError: a stable code for the client, a safe message for people, and an
// HTTP status. Anything else that escapes a handler becomes a generic 500 with no internal detail (logged server-side).
export type ErrorCode =
  | 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'LOCKED'
  | 'PASSWORD_CHANGE_REQUIRED' | 'DEADLINE_PASSED' | 'SERVER_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, LOCKED: 429,
  PASSWORD_CHANGE_REQUIRED: 403, DEADLINE_PASSED: 409, SERVER_ERROR: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.status = STATUS[code];
  }
}

export const validation = (message: string, details?: unknown) => new AppError('VALIDATION', message, details);
export const forbidden = (message = 'You do not have permission to do this.') => new AppError('FORBIDDEN', message);
export const notFound = (message = 'Not found.') => new AppError('NOT_FOUND', message);
export const conflict = (message: string) => new AppError('CONFLICT', message);
