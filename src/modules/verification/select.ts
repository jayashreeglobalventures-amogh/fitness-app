// Which screenshot reader the app uses:
//   ANTHROPIC_API_KEY set          -> Claude (paid, best at unusual layouts)
//   otherwise                      -> Tesseract on the server (free, no key, image never leaves the server)
//   SCREENSHOT_OCR=off and no key  -> none: every screenshot goes to an admin
import { ocrReader } from './ocr.js';
import { anthropicReader, type ScreenshotReader } from './reader.js';

let override: ScreenshotReader | null | undefined;
let free: ScreenshotReader | null = null;

export function currentReader(): ScreenshotReader | null {
  if (override !== undefined) return override;
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return anthropicReader(key);
  if (process.env.SCREENSHOT_OCR === 'off') return null;
  return (free ??= ocrReader());
}

export function readerName(): 'claude' | 'tesseract' | 'off' {
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  return process.env.SCREENSHOT_OCR === 'off' ? 'off' : 'tesseract';
}

/** Tests only. undefined = back to the environment. */
export function setReaderForTests(r: ScreenshotReader | null | undefined): void { override = r; }
