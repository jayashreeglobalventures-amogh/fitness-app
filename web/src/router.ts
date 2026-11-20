// Minimal history-based router: the URL is the source of truth, so links can be shared and Back works.
import { useEffect, useState } from 'react';

export function navigate(to: string): void {
  if (to === location.pathname + location.search) return;
  history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
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
