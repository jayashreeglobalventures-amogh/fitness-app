import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, type Issue } from './api';

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const issues: Issue[] = e.details?.errors ?? [];
  return (
    <div className="alert error" role="alert">
      {e.message ?? String(error)}
      {issues.length > 0 && <ul>{issues.map((i, n) => <li key={n}><code>{i.path}</code> {i.message}</li>)}</ul>}
    </div>
  );
}

export function Warnings({ items }: { items: Issue[] | undefined }) {
  if (!items?.length) return null;
  return <div className="alert warn"><b>Heads-up</b><ul>{items.map((w, i) => <li key={i}>{w.message}</li>)}</ul></div>;
}

/** Loads data once (and again when deps change). */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => live && setState({ data, error: null, loading: false }), (error) => live && setState({ data: null, error, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

export const Loading = () => <p className="muted">Loading…</p>;

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>;
}

const fmtDay = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const day = (d: string | null | undefined) => (d ? fmtDay.format(new Date(`${d}T00:00:00Z`)) : '—');
export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const PHASE_LABEL: Record<string, string> = { DRAFT: 'Draft', UPCOMING: 'Starts soon', ACTIVE: 'Live', FINISHED: 'Finished', ARCHIVED: 'Archived' };

/** Day statuses: label + badge style (PRD 17 daily states). */
export const DAY_STATUS: Record<string, { label: string; tone: string }> = {
  NOT_PARTICIPATING: { label: 'Not taking part', tone: '' },
  UPCOMING: { label: 'Upcoming', tone: '' },
  NOT_SUBMITTED: { label: 'Not submitted', tone: 'warn' },
  SUBMITTED: { label: 'Submitted', tone: 'info' },
  PENDING_VERIFICATION: { label: 'Pending verification', tone: 'info' },
  ACHIEVED: { label: 'Target achieved', tone: 'ok' },
  TARGET_MISSED: { label: 'Target missed', tone: 'danger' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  MISSED_DEADLINE: { label: 'Missed deadline', tone: 'danger' },
  EXCUSED: { label: 'Excused', tone: 'info' },
  REST: { label: 'Rest day', tone: '' },
};
export function StatusBadge({ status }: { status: string }) {
  const s = DAY_STATUS[status] ?? { label: status, tone: '' };
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}
export const time = (iso: string, tz = 'Asia/Kolkata') => new Date(iso).toLocaleString('en-IN', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const newRef = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

/** multipart POST (uploads). */
export async function upload<T>(url: string, fields: Record<string, string>, file?: File | null): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', file);
  const res = await fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new ApiError(res.status, json.errorCode ?? 'ERROR', json.message ?? `Upload failed (${res.status}).`, json.details);
  }
  return json.data as T;
}

/** A round profile picture; falls back to initials if there's no photo or the viewer may not see it. */
export function Avatar({ fileId, name, size = 32 }: { fileId?: number | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  const style = { width: size, height: size, borderRadius: '50%', flex: 'none' as const };
  if (fileId && !failed) return <img src={`/api/files/${fileId}`} alt="" style={{ ...style, objectFit: 'cover' }} onError={() => setFailed(true)} />;
  return <span aria-hidden="true" style={{ ...style, display: 'inline-grid', placeItems: 'center', background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: size * 0.38, fontWeight: 800, color: 'var(--muted)' }}>{initials}</span>;
}

/**
 * Prepares a photo for upload in the browser: square crop from the centre, at most `size` px, JPEG.
 * Works for camera and gallery photos on iPhone and Android (Safari hands HEIC over as JPEG).
 */
export async function squarePhoto(file: File, size = 512): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('That file is not a photo this browser can open.')); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(size, side);
    const canvas = document.createElement('canvas');
    canvas.width = out; canvas.height = out;
    canvas.getContext('2d')!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob) throw new Error('Could not prepare the photo.');
    return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
  } finally { URL.revokeObjectURL(url); }
}
