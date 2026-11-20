// Generates the PWA icons in web/public from one SVG design (run after changing the design): npx tsx scripts/make-icons.ts
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

// Full-bleed background so the icon also works when Android masks it to a circle or squircle ("maskable").
const design = (pad: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0b0f14"/>
  <g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">
    <path d="M96 330 C 150 200, 205 200, 256 280 S 362 360, 416 190" fill="none" stroke="#3ddc97" stroke-width="44" stroke-linecap="round"/>
    <circle cx="416" cy="190" r="30" fill="#3ddc97"/>
  </g></svg>`;
const png = (svg: string, size: number) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
const out = 'web/public';
writeFileSync(`${out}/icon-192.png`, png(design(40), 192));
writeFileSync(`${out}/icon-512.png`, png(design(40), 512));
writeFileSync(`${out}/icon-maskable-512.png`, png(design(96), 512)); // content inside the 80% safe zone
writeFileSync(`${out}/apple-touch-icon.png`, png(design(56), 180));
writeFileSync(`${out}/icon.svg`, design(40));
console.log('icons written');
