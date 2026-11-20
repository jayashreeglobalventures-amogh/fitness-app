// Profile photo cropper: drag to position, zoom in/out (slider, buttons, mouse wheel), round preview of what others see.
// Output: a square JPEG (512 px) made in the browser. Works with touch (iPhone / Android) and mouse.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';

const VIEW = 280;      // size of the crop square on screen (px)
const OUT = 512;       // size of the saved photo (px)
const MAX_ZOOM = 4;

export function PhotoCropper({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (f: File) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // top-left of the image inside the square (px)
  const drag = useRef<{ id: number; x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => { setImg(i); const s = cover(i); setPos({ x: (VIEW - i.naturalWidth * s) / 2, y: (VIEW - i.naturalHeight * s) / 2 }); };
    i.onerror = () => setError('This photo can\'t be opened here. Try another one.');
    i.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const cover = (i: HTMLImageElement) => VIEW / Math.min(i.naturalWidth, i.naturalHeight); // smallest scale that fills the square
  const scale = img ? cover(img) * zoom : 1;
  const w = img ? img.naturalWidth * scale : 0, h = img ? img.naturalHeight * scale : 0;
  // Keep the square always covered by the photo.
  const clamp = (p: { x: number; y: number }, ww = w, hh = h) => ({ x: Math.min(0, Math.max(VIEW - ww, p.x)), y: Math.min(0, Math.max(VIEW - hh, p.y)) });

  const setZoomAround = (z: number) => {
    if (!img) return;
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    const ns = cover(img) * nz;
    // Zoom around the centre of the square.
    const cx = (VIEW / 2 - pos.x) / scale, cy = (VIEW / 2 - pos.y) / scale;
    setZoom(nz);
    setPos(clamp({ x: VIEW / 2 - cx * ns, y: VIEW / 2 - cy * ns }, img.naturalWidth * ns, img.naturalHeight * ns));
  };

  const down = (e: RPointerEvent) => { (e.target as Element).setPointerCapture(e.pointerId); drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }));
  };
  const up = () => { drag.current = null; };

  const save = async () => {
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUT; canvas.height = OUT;
    const side = VIEW / scale;
    canvas.getContext('2d')!.drawImage(img, -pos.x / scale, -pos.y / scale, side, side, 0, 0, OUT, OUT);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (!blob) { setError('Could not prepare the photo.'); return; }
    onDone(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
  };

  return (
    <div className="cropper-backdrop" role="dialog" aria-modal="true" aria-label="Adjust your photo">
      <div className="card cropper">
        <h3>Adjust your photo</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Drag to position it. Zoom in or out. The circle is what others see.</p>
        {error ? <div className="alert error">{error}</div> : (
          <div className="cropper-view" style={{ width: VIEW, height: VIEW }}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
            onWheel={(e) => setZoomAround(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))}>
            {img && <img src={img.src} alt="" draggable={false} style={{ position: 'absolute', left: pos.x, top: pos.y, width: w, height: h, maxWidth: 'none', userSelect: 'none', pointerEvents: 'none' }} />}
            <div className="cropper-mask" />
          </div>
        )}
        <div className="row" style={{ marginTop: 12, flexWrap: 'nowrap' }}>
          <button className="btn small" onClick={() => setZoomAround(zoom / 1.2)} aria-label="Zoom out">−</button>
          <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={zoom} onChange={(e) => setZoomAround(Number(e.target.value))} aria-label="Zoom" style={{ flex: 1 }} />
          <button className="btn small" onClick={() => setZoomAround(zoom * 1.2)} aria-label="Zoom in">+</button>
        </div>
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!img} onClick={() => void save()}>Use this photo</button>
        </div>
      </div>
    </div>
  );
}
