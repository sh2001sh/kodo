import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { KodoError } from '../runtime/types.js';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export interface ImageInput { mimeType: ImageMimeType; data: string }
export interface ImageReadResult {
  path: string; mimeType: ImageMimeType; width: number; height: number; bytes: number; sha256: string; image: ImageInput;
}
export const maximumImageBytes = 5 * 1024 * 1024;
const invalid = (message = 'unsupported, malformed or truncated image'): never => { throw new KodoError('IMAGE_FORMAT', message); };
const dimensions = (width: number, height: number): { width: number; height: number } => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 40_000_000) invalid('image dimensions exceed 16384 per side or 40 million pixels');
  return { width, height };
};

/** The caller must resolve the workspace path and enforce read scope before invoking this byte reader. */
export async function readImage(file: string, signal: AbortSignal): Promise<ImageReadResult> {
  signal.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new KodoError('IMAGE_FORMAT', 'image input must be a regular file');
    if (before.size > maximumImageBytes) throw new KodoError('IMAGE_SIZE', 'image input exceeds 5 MiB');
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximumImageBytes + 1 - bytes));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > maximumImageBytes) throw new KodoError('IMAGE_SIZE', 'image input exceeds 5 MiB');
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    signal.throwIfAborted();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== after.size) throw new KodoError('FILE_CONFLICT', 'image changed while reading');
    const buffer = Buffer.concat(chunks);
    const metadata = imageMetadata(buffer);
    return { path: file, ...metadata, bytes, sha256: createHash('sha256').update(buffer).digest('hex'), image: { mimeType: metadata.mimeType, data: buffer.toString('base64') } };
  } finally { await handle.close(); }
}

/** Container validation bounds every length before reading dimensions; extensions are never trusted. */
export function imageMetadata(buffer: Buffer): { mimeType: ImageMimeType; width: number; height: number } {
  if (buffer.length > maximumImageBytes) throw new KodoError('IMAGE_SIZE', 'image input exceeds 5 MiB');
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: 'image/png', ...png(buffer) };
  if (buffer.length >= 2 && buffer.readUInt16BE(0) === 0xffd8) return { mimeType: 'image/jpeg', ...jpeg(buffer) };
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return { mimeType: 'image/gif', ...gif(buffer) };
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { mimeType: 'image/webp', ...webp(buffer) };
  return invalid('only PNG, JPEG, GIF and WebP image inputs are supported');
}

/** Validate public provider attachments too, including canonical base64 and actual bytes. */
export function validateImageInput(value: ImageInput): ImageInput {
  if (!value || typeof value.data !== 'string' || value.data.length > Math.ceil(maximumImageBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw new KodoError('MODEL_PROTOCOL', 'invalid image attachment');
  try {
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.toString('base64') !== value.data || imageMetadata(bytes).mimeType !== value.mimeType) throw new Error('image MIME mismatch');
  } catch { throw new KodoError('MODEL_PROTOCOL', 'invalid image attachment'); }
  return value;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(buffer: Buffer): { width: number; height: number } {
  let offset = 8;
  let size: ReturnType<typeof dimensions> | undefined;
  let pixels = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) return invalid();
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) return invalid();
    if (!size && type !== 'IHDR') return invalid();
    if (type === 'IHDR') {
      if (size || length !== 13) return invalid();
      size = dimensions(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12));
      const depth = buffer[offset + 16]!;
      const color = buffer[offset + 17]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || buffer[offset + 18] !== 0 || buffer[offset + 19] !== 0 || buffer[offset + 20]! > 1) return invalid();
    } else if (type === 'IDAT' && length > 0) pixels = true;
    else if (type === 'IEND') {
      if (length !== 0 || end !== buffer.length || !size || !pixels) return invalid();
      return size;
    }
    offset = end;
  }
  return invalid();
}
function jpeg(buffer: Buffer): { width: number; height: number } {
  let offset = 2;
  let size: ReturnType<typeof dimensions> | undefined;
  let scan = false;
  while (offset < buffer.length) {
    if (buffer[offset++] !== 0xff) return invalid();
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9) return size && scan && offset === buffer.length ? size : invalid();
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > buffer.length) return invalid();
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size || length < 8) return invalid();
      const components = buffer[offset + 7]!;
      if (buffer[offset + 2] !== 8 || ![1, 3, 4].includes(components) || length !== 8 + 3 * components) return invalid();
      size = dimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    } else if (marker === 0xda) {
      if (!size || length < 6 || length !== 6 + 2 * buffer[offset + 2]!) return invalid();
      scan = true;
      offset += length;
      const start = offset;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const next = buffer[offset + 1];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
      if (offset === start) return invalid();
      continue;
    }
    offset += length;
  }
  return invalid();
}
function gif(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 14) return invalid();
  const size = dimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  let offset = 13 + ((buffer[10]! & 0x80) ? 3 * (1 << ((buffer[10]! & 7) + 1)) : 0);
  let image = false;
  const blocks = (): void => {
    while (offset < buffer.length) {
      const length = buffer[offset++]!;
      if (!length) return;
      if (offset + length > buffer.length) return invalid();
      offset += length;
    }
    return invalid();
  };
  while (offset < buffer.length) {
    const marker = buffer[offset++];
    if (marker === 0x3b) return image && offset === buffer.length ? size : invalid();
    if (marker === 0x21) { if (offset >= buffer.length) return invalid(); offset++; blocks(); }
    else if (marker === 0x2c) {
      if (offset + 9 > buffer.length) return invalid();
      const left = buffer.readUInt16LE(offset), top = buffer.readUInt16LE(offset + 2);
      const frame = dimensions(buffer.readUInt16LE(offset + 4), buffer.readUInt16LE(offset + 6));
      if (left + frame.width > size.width || top + frame.height > size.height) return invalid();
      const packed = buffer[offset + 8]!;
      offset += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
      if (offset >= buffer.length || buffer[offset]! < 2 || buffer[offset]! > 8) return invalid();
      offset++;
      const start = offset;
      blocks();
      if (offset - start <= 1) return invalid();
      image = true;
    } else return invalid();
  }
  return invalid();
}
function webp(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 20 || buffer.readUInt32LE(4) + 8 !== buffer.length) return invalid();
  let offset = 12;
  let size: ReturnType<typeof dimensions> | undefined;
  let pixels = false;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end + (length & 1) > buffer.length) return invalid();
    if (type === 'VP8X') {
      if (size || offset !== 12 || length !== 10) return invalid();
      size = dimensions(1 + buffer.readUIntLE(start + 4, 3), 1 + buffer.readUIntLE(start + 7, 3));
    } else if (type === 'VP8 ') {
      if (length < 10 || (buffer[start]! & 1) || !buffer.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) return invalid();
      const frame = dimensions(buffer.readUInt16LE(start + 6) & 0x3fff, buffer.readUInt16LE(start + 8) & 0x3fff);
      if (size && (size.width !== frame.width || size.height !== frame.height)) return invalid();
      size = frame; pixels = true;
    } else if (type === 'VP8L') {
      if (length < 5 || buffer[start] !== 0x2f || buffer[start + 4]! >> 5) return invalid();
      const bits = buffer.readUInt32LE(start + 1);
      const frame = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      if (size && (size.width !== frame.width || size.height !== frame.height)) return invalid();
      size = frame; pixels = true;
    } else if (type === 'ANMF') return invalid('animated WebP is unsupported; use a static frame');
    offset = end + (length & 1);
  }
  return offset === buffer.length && size && pixels ? size : invalid();
}
