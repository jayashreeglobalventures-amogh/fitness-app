import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './themes.css';
import { initTheme } from './theme';

initTheme();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Installable app (PWA) on Android and iPhone. Only in the built app, so development reloads stay simple.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}
