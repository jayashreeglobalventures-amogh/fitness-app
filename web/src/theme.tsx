// Colour themes (Profile → Appearance): a palette and Light / Dark / Automatic, remembered on this device.
// A link with ?palette=sunset (or ?mode=light) previews one and remembers it, handy for comparing on a phone.
import { useState } from 'react';
import { applyBackground, backgroundFromLink, BackgroundPicker } from './background';
import { Collapsible } from './ui';

export const PALETTES = {
  classic: { name: 'Classic Mint', note: 'Today\'s look: calm green on charcoal', colors: ['#0b0f14', '#3ddc97', '#3ddc97'] },
  sunset: { name: 'Sunset', note: 'Warm coral to pink, on deep plum', colors: ['#140b12', '#ff7a59', '#ff3d8b'] },
  ocean: { name: 'Ocean Pop', note: 'Electric blue to violet, on navy', colors: ['#07101f', '#38bdf8', '#a78bfa'] },
  neon: { name: 'Neon Sport', note: 'Lime to hot pink, on black - very sporty', colors: ['#0a0a0a', '#c6ff3d', '#ff3dac'] },
  berry: { name: 'Berry Bloom', note: 'Lavender to pink - soft and friendly', colors: ['#110d1c', '#b794ff', '#ff8fcf'] },
} as const;
export type Palette = keyof typeof PALETTES;
/** What everyone sees until they pick another (owner, 23 Nov 2026). */
export const DEFAULT_PALETTE: Palette = 'sunset';
export type Mode = 'auto' | 'light' | 'dark';

const KEY = { palette: 'fit:palette', mode: 'fit:mode' };
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window: just for now */ } };

export function applyTheme(palette: Palette, mode: Mode): void {
  const el = document.documentElement;
  if (palette === 'classic') delete el.dataset.palette; else el.dataset.palette = palette;
  if (mode === 'auto') delete el.dataset.mode; else el.dataset.mode = mode;
  // The phone's status bar follows the page background.
  requestAnimationFrame(() => document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.body).backgroundColor));
}

/** On start: a preview link wins (and is remembered), otherwise what was chosen on this device. */
export function initTheme(): void {
  const q = new URLSearchParams(location.search);
  const qp = q.get('palette'), qm = q.get('mode');
  if (qp && qp in PALETTES) write(KEY.palette, qp);
  if (qm && ['auto', 'light', 'dark'].includes(qm)) write(KEY.mode, qm);
  applyTheme(current().palette, current().mode);
  backgroundFromLink(q);
  applyBackground();
}

function current(): { palette: Palette; mode: Mode } {
  const p = read(KEY.palette), m = read(KEY.mode);
  return { palette: p && p in PALETTES ? (p as Palette) : DEFAULT_PALETTE, mode: m === 'light' || m === 'dark' ? m : 'auto' };
}

export function AppearanceCard() {
  const [t, setT] = useState(current);
  const pick = (palette: Palette, mode: Mode) => { write(KEY.palette, palette); write(KEY.mode, mode); applyTheme(palette, mode); setT({ palette, mode }); };
  return (
    <Collapsible id="appearance" title="🎨 Appearance" defaultOpen={false}>
      <p className="muted small">Pick a colour theme. It changes this device only.</p>
      <div className="swatches">
        {(Object.keys(PALETTES) as Palette[]).map((k) => (
          <button key={k} type="button" className="swatch" aria-pressed={t.palette === k} onClick={() => pick(k, t.mode)}>
            <span className="swatch-bar" aria-hidden="true">{PALETTES[k].colors.map((c, i) => <span key={i} style={{ background: c }} />)}</span>
            <b className="small">{PALETTES[k].name}</b>
            <span className="muted small">{PALETTES[k].note}</span>
          </button>
        ))}
      </div>
      <div className="subnav inline" style={{ marginTop: 12 }}>
        {(['auto', 'light', 'dark'] as Mode[]).map((m) => (
          <button key={m} type="button" aria-current={t.mode === m} onClick={() => pick(t.palette, m)}>{m === 'auto' ? 'Automatic' : m === 'light' ? '☀️ Light' : '🌙 Dark'}</button>
        ))}
      </div>
      <BackgroundPicker />
    </Collapsible>
  );
}
