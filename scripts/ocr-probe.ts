// Developer tool: run the free screenshot reader on image files and print what it reads.
//   npx tsx scripts/ocr-probe.ts <image> [expected-day YYYY-MM-DD]      (no arguments: the built-in mock screenshots)
import { readFileSync } from 'node:fs';
import { appleHealthLike, googleFitLike, samsungHealthLike, weeklySummaryLike } from '../test/helpers/screens.js';
import { interpretOcr, ocrLines, shutdownOcr } from '../src/modules/verification/ocr.js';

const day = process.argv[3] ?? '2026-11-22';
const images: [string, Buffer][] = process.argv[2] ? [[process.argv[2], readFileSync(process.argv[2])]] : [
  ['google-fit', googleFitLike('8,214', 'Sun, 22 Nov')], ['samsung', samsungHealthLike('7,056', '6,000', 'Sun, 22 November')],
  ['apple', appleHealthLike('9,302', '22 Nov 2026')], ['weekly', weeklySummaryLike()],
];
for (const [name, img] of images) {
  const t = Date.now();
  const lines = await ocrLines(img);
  console.log(`\n== ${name} (${Date.now() - t} ms)`);
  for (const l of lines) console.log(`  [${Math.round(l.confidence)}] ${l.text}`);
  console.log('  ->', JSON.stringify(interpretOcr(lines, { expectedDay: day, timeZone: 'Asia/Kolkata', metricLabel: 'Steps', unit: 'steps' })));
}
await shutdownOcr();
