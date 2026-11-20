// Thin client for the JSON API. Same origin, cookie session. Every response is {success, data} or
// {success:false, errorCode, message, details?}.
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: { errors?: Issue[] }) { super(message); }
}
export interface Issue { path: string; message: string }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: { success?: boolean; data?: T; errorCode?: string; message?: string; details?: { errors?: Issue[] } } = {};
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok || json.success === false) {
    if (res.status === 401 && url !== '/api/auth/login') window.dispatchEvent(new Event('fit:signed-out'));
    if (json.errorCode === 'PASSWORD_CHANGE_REQUIRED') window.dispatchEvent(new Event('fit:password-change'));
    throw new ApiError(res.status, json.errorCode ?? 'ERROR', json.message ?? `Request failed (${res.status}).`, json.details);
  }
  return json.data as T;
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => call<T>('POST', url, body),
  put: <T>(url: string, body: unknown = {}) => call<T>('PUT', url, body),
};

export interface Me { userId: number; username: string; displayName: string; mustChangePassword: boolean; superAdmin: boolean; canManageAccounts: boolean; canCreateChallenges: boolean }
export type Phase = 'DRAFT' | 'UPCOMING' | 'ACTIVE' | 'FINISHED' | 'ARCHIVED';
export interface ChallengeListItem {
  challengeId: number; slug: string; name: string; category: string; status: string; timeZone: string; startsOn: string; endsOn: string;
  phase: Phase; description: string; myRoles: string[]; participantStatus: string | null; openInvitationId: number | null;
}
