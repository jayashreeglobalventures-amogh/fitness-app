// Private image storage (AaryaShree IMS pattern): bytes on the media volume, content-addressed by SHA-256 under the
// uploader's folder; metadata and ownership in PostgreSQL (files table). The type is decided from the bytes, never
// from the client's file name or MIME type. Files are only ever served through authorised routes.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validation } from './errors.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export function sniffImage(b: Buffer): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export interface StoredImage { storageKey: string; sha256: string; mimeType: ImageMime; bytes: number }

export async function storeImage(mediaDir: string, ownerUserId: number, bytes: Buffer): Promise<StoredImage> {
  if (!bytes.length) throw validation('The file is empty.');
  if (bytes.length > MAX_IMAGE_BYTES) throw validation('The image is larger than 10 MB.');
  const mimeType = sniffImage(bytes);
  if (!mimeType) throw validation('Upload a JPEG, PNG or WebP image (a screenshot or photo).');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storageKey = `u/${ownerUserId}/sha256/${sha256.slice(0, 2)}/${sha256}`;
  const file = resolveKey(mediaDir, storageKey);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.part`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, file); // identical content -> identical file: overwriting is harmless
  return { storageKey, sha256, mimeType, bytes: bytes.length };
}

export function resolveKey(mediaDir: string, storageKey: string): string {
  const root = path.resolve(mediaDir);
  const file = path.resolve(root, storageKey);
  if (!file.startsWith(root + path.sep)) throw new Error('storage key escapes the media directory');
  return file;
}

export const readImage = (mediaDir: string, storageKey: string) => readFile(resolveKey(mediaDir, storageKey));

/** Deletes a stored image for good (an admin erasing a private photo). Missing already = fine. */
export async function eraseImage(mediaDir: string, storageKey: string): Promise<void> {
  await rm(resolveKey(mediaDir, storageKey), { force: true });
}
