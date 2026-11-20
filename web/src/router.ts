// Minimal history-based router: the URL is the source of truth, so links can be shared and Back works.
import { useEffect, useState } from 'react';

// The page the person was on before the current one (inside the app), for "Back" buttons.
let previous: string | null = null;
export const previousPath = () => previous;

export function navigate(to: string): void {
  if (to === location.pathname + location.search) return;
  previous = location.pathname + location.search;
  history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

/** Back to where the person came from in the app (browser history), or to `fallback` when there is none. */
export function goBack(fallback = '/'): void {
  if (previous) history.back();
  else navigate(fallback);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}
