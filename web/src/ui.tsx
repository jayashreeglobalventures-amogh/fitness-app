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
