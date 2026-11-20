// Phone-sized mock screenshots of common step apps, drawn as SVG and rasterised to PNG (resvg), for testing the real
// OCR path. They imitate layout and typography only - no logos or artwork.
import { Resvg } from '@resvg/resvg-js';

const W = 1080, H = 2340;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
type T = { x: number; y: number; size: number; text: string; weight?: number; fill?: string; anchor?: 'start' | 'middle' | 'end' };

function render(bg: string, fg: string, items: T[], extra = ''): Buffer {
  const texts = items.map((t) => `<text x="${t.x}" y="${t.y}" font-size="${t.size}" font-weight="${t.weight ?? 400}" fill="${t.fill ?? fg}" text-anchor="${t.anchor ?? 'start'}" font-family="Roboto, Helvetica, Arial, DejaVu Sans, sans-serif">${esc(t.text)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${bg}"/>${extra}${texts}</svg>`;
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true }, background: bg }).render().asPng());
}
const status = (fg: string): T[] => [{ x: 60, y: 80, size: 40, text: '9:41', weight: 600, fill: fg }, { x: 1020, y: 80, size: 36, text: '87%', anchor: 'end', fill: fg }];

export function googleFitLike(steps: string, dateLabel: string): Buffer {
  return render('#ffffff', '#202124', [
    ...status('#202124'),
    { x: 540, y: 260, size: 48, text: dateLabel, anchor: 'middle', weight: 500 },
    { x: 540, y: 760, size: 150, text: steps, anchor: 'middle', weight: 500 },
    { x: 540, y: 860, size: 56, text: 'Steps', anchor: 'middle' },
    { x: 540, y: 950, size: 40, text: 'Goal 10,000', anchor: 'middle', fill: '#5f6368' },
    { x: 180, y: 1250, size: 52, text: '5.21', anchor: 'middle', weight: 500 }, { x: 180, y: 1320, size: 38, text: 'km', anchor: 'middle', fill: '#5f6368' },
    { x: 540, y: 1250, size: 52, text: '312', anchor: 'middle', weight: 500 }, { x: 540, y: 1320, size: 38, text: 'kcal', anchor: 'middle', fill: '#5f6368' },
    { x: 900, y: 1250, size: 52, text: '64', anchor: 'middle', weight: 500 }, { x: 900, y: 1320, size: 38, text: 'Move Min', anchor: 'middle', fill: '#5f6368' },
  ], '<circle cx="540" cy="700" r="330" fill="none" stroke="#1a73e8" stroke-width="36"/>');
}

export function samsungHealthLike(steps: string, goal: string, dateLabel: string): Buffer {
  return render('#f6f6f6', '#1c1c1c', [
    ...status('#1c1c1c'),
    { x: 70, y: 230, size: 64, text: 'Steps', weight: 700 },
    { x: 70, y: 320, size: 44, text: dateLabel, fill: '#555555' },
    { x: 70, y: 600, size: 140, text: steps, weight: 700 },
    { x: 70, y: 690, size: 54, text: `/${goal} steps`, fill: '#555555' },
    { x: 70, y: 900, size: 46, text: '4.8 km', fill: '#333333' },
    { x: 560, y: 900, size: 46, text: '276 kcal', fill: '#333333' },
  ], '<rect x="40" y="420" width="1000" height="560" rx="40" fill="#ffffff"/>');
}

export function appleHealthLike(steps: string, dateLabel: string): Buffer {
  return render('#000000', '#ffffff', [
    ...status('#ffffff'),
    { x: 60, y: 250, size: 76, text: 'Steps', weight: 700 },
    { x: 60, y: 420, size: 40, text: 'TOTAL', fill: '#8e8e93', weight: 600 },
    { x: 60, y: 540, size: 120, text: steps, weight: 700 },
    { x: 60, y: 620, size: 48, text: 'steps', fill: '#8e8e93' },
    { x: 60, y: 700, size: 44, text: dateLabel, fill: '#8e8e93' },
  ]);
}

export function weeklySummaryLike(): Buffer {
  return render('#ffffff', '#202124', [
    ...status('#202124'),
    { x: 70, y: 260, size: 56, text: '16 - 22 Nov', weight: 600 },
    { x: 70, y: 420, size: 46, text: 'Daily average 7,412 steps' },
    { x: 70, y: 520, size: 46, text: 'Total this week 51,884 steps' },
  ]);
}
