// The real free reader (Tesseract, on this machine) on mock phone screenshots of common step apps.
import { afterAll, describe, expect, it } from 'vitest';
import { judge } from '../../src/modules/checkin/submissions.js';
import { ocrReader, shutdownOcr } from '../../src/modules/verification/ocr.js';
import { appleHealthLike, googleFitLike, samsungHealthLike, weeklySummaryLike } from '../helpers/screens.js';

const ctx = { expectedDay: '2026-11-22', timeZone: 'Asia/Kolkata', metricLabel: 'Steps', unit: 'steps' };
const reader = ocrReader();
const decide = async (img: Buffer, day = ctx.expectedDay) => {
  const r = await reader.read(img, 'image/png', { ...ctx, expectedDay: day });
  return { r, ...judge(r, day, 7000, 0.9, null) };
};
afterAll(async () => { await shutdownOcr(); });

describe('free screenshot reading (Tesseract on the server)', () => {
  it('Google Fit-style screenshot on target -> approved', async () => {
    const d = await decide(googleFitLike('8,214', 'Sun, 22 Nov'));
    expect(d.r).toMatchObject({ provider: 'tesseract', value: 8214, date: '2026-11-22' });
    expect(d.approve).toBe(true);
  }, 60_000);

  it('Samsung Health-style (goal shown as "/6,000 steps") -> approved with the real total', async () => {
    const d = await decide(samsungHealthLike('7,056', '6,000', 'Sun, 22 November'));
    expect(d.r.value).toBe(7056);
    expect(d.approve).toBe(true);
  }, 60_000);

  it('Apple Health-style dark screen -> approved', async () => {
    const d = await decide(appleHealthLike('9,302', '22 Nov 2026'));
    expect(d.r.value).toBe(9302);
    expect(d.approve).toBe(true);
  }, 60_000);

  it('below target -> admin', async () => {
    const d = await decide(googleFitLike('6,480', 'Sun, 22 Nov'));
    expect(d.r.value).toBe(6480);
    expect(d.approve).toBe(false);
    expect(d.flags).toContain('BELOW_TARGET');
  }, 60_000);

  it('yesterday\'s screenshot -> admin', async () => {
    const d = await decide(googleFitLike('8,214', 'Sat, 21 Nov'));
    expect(d.approve).toBe(false);
    expect(d.flags).toContain('DATE_MISMATCH');
  }, 60_000);

  it('weekly summary -> admin', async () => {
    const d = await decide(weeklySummaryLike());
    expect(d.approve).toBe(false);
    expect(d.flags).toEqual(expect.arrayContaining(['WEEKLY_OR_AVERAGE']));
  }, 60_000);

  it('an image with no text -> unreadable -> admin', async () => {
    const { Resvg } = await import('@resvg/resvg-js');
    const blank = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="100%" height="100%" fill="#336699"/></svg>').render().asPng());
    const d = await decide(blank);
    expect(d.r.readable).toBe(false);
    expect(d.approve).toBe(false);
  }, 60_000);
});
