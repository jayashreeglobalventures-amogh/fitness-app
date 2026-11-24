// Which screenshot reader the app uses:
//   ANTHROPIC_API_KEY set          -> Claude (paid, best at unusual layouts)
//   OMNIROUTE_API_KEY set          -> a vision model through the OmniRoute gateway (OMNIROUTE_VISION_MODEL), with
//                                     Tesseract as the backup when the gateway fails (unless SCREENSHOT_OCR=off)
//   otherwise                      -> Tesseract on the server (free, no key, image never leaves the server)
//   SCREENSHOT_OCR=off and no key  -> none: every screenshot goes to an admin
import { omniRouteConfig } from '../../core/omniroute.js';
import { ocrReader } from './ocr.js';
import { omnirouteReader, withBackup } from './omniroute-reader.js';
import { anthropicReader, type ScreenshotReader } from './reader.js';

let override: ScreenshotReader | null | undefined;
let free: ScreenshotReader | null = null;

export function currentReader(): ScreenshotReader | null {
  if (override !== undefined) return override;
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return anthropicReader(key);
  const ocrOn = process.env.SCREENSHOT_OCR !== 'off';
  const gateway = omniRouteConfig();
  if (gateway) {
    const ai = omnirouteReader(gateway, process.env.OMNIROUTE_VISION_MODEL?.trim() || undefined);
    return ocrOn ? withBackup(ai, (free ??= ocrReader())) : ai;
  }
  if (!ocrOn) return null;
  return (free ??= ocrReader());
}

export function readerName(): 'claude' | 'omniroute' | 'tesseract' | 'off' {
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (omniRouteConfig()) return 'omniroute';
  return process.env.SCREENSHOT_OCR === 'off' ? 'off' : 'tesseract';
}

/** Tests only. undefined = back to the environment. */
export function setReaderForTests(r: ScreenshotReader | null | undefined): void { override = r; }
