// A faded picture behind the app (Profile → Appearance): one of a few built-in scenes (drawn here, nothing to
// download) or the person's own photo. Everything stays on this device: the photo is shrunk and kept in the
// browser's storage, never uploaded. "How visible" fades it so text stays easy to read.
import { useState, type ChangeEvent } from 'react';

const svg = (body: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 1000' preserveAspectRatio='xMidYMid slice'>${body}</svg>`)}")`;

export const SCENES = {
  hills: { name: 'Sunrise hills', image: svg(
    `<defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ff9a76'/><stop offset='1' stop-color='#ff3d8b'/></linearGradient></defs>
     <rect width='1600' height='1000' fill='url(#s)'/><circle cx='1150' cy='420' r='150' fill='#ffd27a'/>
     <path d='M0 640 Q300 520 620 620 T1250 600 T1600 560 V1000 H0Z' fill='#c2416b'/>
     <path d='M0 760 Q380 640 760 740 T1600 700 V1000 H0Z' fill='#8e2b55'/>
     <path d='M0 880 Q420 790 900 870 T1600 850 V1000 H0Z' fill='#5a1a3a'/>`) },
  track: { name: 'Running track', image: svg(
    `<rect width='1600' height='1000' fill='#b5452f'/>
     ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<path d='M-100 ${300 + i * 110} C 500 ${120 + i * 110}, 1100 ${480 + i * 110}, 1700 ${260 + i * 110}' stroke='#f6e7dc' stroke-width='6' fill='none'/>`).join('')}
     <text x='1300' y='930' font-family='Arial' font-weight='700' font-size='140' fill='#f6e7dc' opacity='.8'>7K</text>`) },
  peaks: { name: 'Mountain peaks', image: svg(
    `<defs><linearGradient id='k' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#38bdf8'/><stop offset='1' stop-color='#a78bfa'/></linearGradient></defs>
     <rect width='1600' height='1000' fill='url(#k)'/>
     <path d='M0 820 L360 380 L620 700 L900 300 L1240 760 L1450 520 L1600 680 V1000 H0Z' fill='#1e3a8a'/>
     <path d='M900 300 L980 400 L940 390 L900 430 L860 390 L820 400Z M360 380 L420 455 L380 448 L340 470 L300 450Z' fill='#e0f2fe'/>
     <path d='M0 900 L300 640 L560 880 L860 620 L1200 900 L1600 700 V1000 H0Z' fill='#172554'/>`) },
  waves: { name: 'Calm waves', image: svg(
    `<rect width='1600' height='1000' fill='#0f766e'/>
     ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<path d='M0 ${120 + i * 120} Q200 ${60 + i * 120} 400 ${120 + i * 120} T800 ${120 + i * 120} T1200 ${120 + i * 120} T1600 ${120 + i * 120}' stroke='#5eead4' stroke-width='${10 - i}' fill='none' opacity='${0.9 - i * 0.08}'/>`).join('')}`) },
} as const;
export type Scene = keyof typeof SCENES;
type Choice = 'none' | Scene | 'photo';

const KEY = { choice: 'fit:bg', photo: 'fit:bg-photo', fade: 'fit:bg-fade' };
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };

function state(): { choice: Choice; fade: number } {
  const c = read(KEY.choice);
  const f = Number(read(KEY.fade));
  return { choice: c === 'photo' || (c && c in SCENES) ? (c as Choice) : 'none', fade: f >= 5 && f <= 60 ? f : 18 };
}

/** A preview link (?bg=hills, ?bg=none, &bgfade=25) chooses and remembers one. */
export function backgroundFromLink(q: URLSearchParams): void {
  const b = q.get('bg'), f = Number(q.get('bgfade'));
  if (b && (b === 'none' || b in SCENES)) write(KEY.choice, b);
  if (f >= 5 && f <= 60) write(KEY.fade, String(f));
}

export function applyBackground(): void {
  const { choice, fade } = state();
  const el = document.documentElement;
  const photo = choice === 'photo' ? read(KEY.photo) : null;
  const image = choice === 'photo' ? (photo ? `url("${photo}")` : null) : choice === 'none' ? null : SCENES[choice].image;
  el.classList.toggle('has-bg', !!image);
  if (image) { el.style.setProperty('--bg-image', image); el.style.setProperty('--bg-fade', String(fade / 100)); }
  else { el.style.removeProperty('--bg-image'); el.style.removeProperty('--bg-fade'); }
}

/** Shrinks a photo to at most 1600 px on its long side, as a JPEG small enough for the browser's storage. */
async function shrink(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

export function BackgroundPicker() {
  const [s, setS] = useState(state);
  const [note, setNote] = useState<string | null>(null);
  const hasPhoto = !!read(KEY.photo);
  const choose = (choice: Choice) => { write(KEY.choice, choice); applyBackground(); setS(state()); };
  const setFade = (fade: number) => { write(KEY.fade, String(fade)); applyBackground(); setS(state()); };
  const usePhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setNote(null);
    try {
      if (!write(KEY.photo, await shrink(f))) { setNote('That photo is too big to keep on this device. Try a smaller one.'); return; }
      choose('photo');
    } catch { setNote('That file could not be read as a picture.'); }
  };
  const removePhoto = () => { try { localStorage.removeItem(KEY.photo); } catch { /* fine */ } choose('none'); };
  const thumb = (image: string | null) => ({ backgroundImage: image ?? undefined, backgroundSize: 'cover', backgroundPosition: 'center' });

  return (
    <div style={{ marginTop: 16 }}>
      <b className="small">Background picture</b>
      <p className="muted small" style={{ margin: '2px 0 8px' }}>Shown faded behind everything. Your own photo stays on this device only - it is never uploaded.</p>
      <div className="bg-choices">
        <button type="button" className="bg-choice" aria-pressed={s.choice === 'none'} onClick={() => choose('none')}><span className="bg-thumb none">⦸</span><span className="small">None</span></button>
        {(Object.keys(SCENES) as Scene[]).map((k) => (
          <button key={k} type="button" className="bg-choice" aria-pressed={s.choice === k} onClick={() => choose(k)}>
            <span className="bg-thumb" style={thumb(SCENES[k].image)} /><span className="small">{SCENES[k].name}</span>
          </button>
        ))}
        {hasPhoto && (
          <button type="button" className="bg-choice" aria-pressed={s.choice === 'photo'} onClick={() => choose('photo')}>
            <span className="bg-thumb" style={thumb(`url("${read(KEY.photo)}")`)} /><span className="small">My photo</span>
          </button>
        )}
        <label className="bg-choice">
          <span className="bg-thumb none">＋</span><span className="small">{hasPhoto ? 'Another photo' : 'My photo…'}</span>
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => void usePhoto(e)} />
        </label>
      </div>
      {note && <div className="alert warn small" style={{ marginTop: 8 }}>{note}</div>}
      {s.choice !== 'none' && (
        <div className="row" style={{ marginTop: 10 }}>
          <label className="small" htmlFor="bg-fade">How visible</label>
          <input id="bg-fade" type="range" min={5} max={60} step={1} value={s.fade} onChange={(e) => setFade(Number(e.target.value))} style={{ flex: 1, minWidth: 140 }} />
          <span className="small muted" style={{ width: 36 }}>{s.fade}%</span>
          {s.choice === 'photo' && <button type="button" className="btn ghost small" onClick={removePhoto}>Remove my photo</button>}
        </div>
      )}
    </div>
  );
}
