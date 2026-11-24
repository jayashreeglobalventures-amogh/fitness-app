// Screenshot reading through the OmniRoute gateway with a vision model (default: NVIDIA Nemotron VL), using the same
// instructions and output shape as the Claude reader. The AI only *reads*; judge() decides, and only ever approves.
//
//   OMNIROUTE_VISION_MODEL   default nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b
import { chatJson, OmniRouteError, type OmniRouteConfig } from '../../core/omniroute.js';
import { parseReading, READING_SCHEMA, READING_SYSTEM, readingPrompt, ReaderError, type ScreenshotReader } from './reader.js';

export const DEFAULT_VISION_MODEL = 'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b';

export function omnirouteReader(cfg: OmniRouteConfig, model = DEFAULT_VISION_MODEL): ScreenshotReader {
  return {
    async read(image, mimeType, ctx) {
      let out;
      try {
        out = await chatJson(cfg, {
          model,
          system: READING_SYSTEM,
          user: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image.toString('base64')}` } },
            { type: 'text', text: readingPrompt(ctx) },
          ],
          schema: { name: 'screenshot_reading', schema: READING_SCHEMA },
          maxTokens: 4000,
          timeoutMs: 90_000,
        });
      } catch (e) {
        if (e instanceof OmniRouteError) throw new ReaderError(e.message, e.retryable);
        throw new ReaderError('Screenshot reading failed.', true);
      }
      const j = out.json;
      // Some models report confidence as a percentage (e.g. 95): bring it back to 0..1 before parseReading clamps it.
      if (typeof j.confidence === 'number' && j.confidence > 1 && j.confidence <= 100) j.confidence = j.confidence / 100;
      return parseReading(j, out.model, 'omniroute');
    },
  };
}

/**
 * Tries the primary reader; if it fails for any reason, the backup reads the screenshot instead (so an AI outage
 * doesn't push every screenshot to an admin). The reading notes say the backup was used.
 */
export function withBackup(primary: ScreenshotReader, backup: ScreenshotReader): ScreenshotReader {
  return {
    async read(image, mimeType, ctx) {
      let first: ReaderError;
      try {
        return await primary.read(image, mimeType, ctx);
      } catch (e) {
        first = e instanceof ReaderError ? e : new ReaderError('Screenshot reading failed.', true);
      }
      try {
        const r = await backup.read(image, mimeType, ctx);
        return { ...r, notes: [`AI reader unavailable (${first.message}); read by the backup reader.`, r.notes].filter(Boolean).join(' ').slice(0, 300) };
      } catch (e) {
        const second = e instanceof ReaderError ? e : new ReaderError('Screenshot reading failed.', true);
        // Retry later if either reader might work then.
        throw new ReaderError(`${first.message} Backup: ${second.message}`.slice(0, 200), first.retryable || second.retryable);
      }
    },
  };
}
