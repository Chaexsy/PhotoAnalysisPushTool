import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import exifr from 'exifr';
import type { PhotoMetadata } from './types.js';

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (Array.isArray(value)) return value.map(item => jsonSafe(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[循环引用]';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = jsonSafe(item, seen);
    seen.delete(value);
    return result;
  }
  return String(value);
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function readMetadata(filePath: string): Promise<PhotoMetadata> {
  try {
    const data = await exifr.parse(filePath, true) as Record<string, unknown> | undefined;
    const capturedAt = data?.DateTimeOriginal instanceof Date ? data.DateTimeOriginal : data?.CreateDate instanceof Date ? data.CreateDate : null;
    const latitudeValue = data?.latitude;
    const longitudeValue = data?.longitude;
    const latitude = typeof latitudeValue === 'number' && Number.isFinite(latitudeValue) && Math.abs(latitudeValue) <= 90 ? latitudeValue : null;
    const longitude = typeof longitudeValue === 'number' && Number.isFinite(longitudeValue) && Math.abs(longitudeValue) <= 180 ? longitudeValue : null;
    return { capturedAt, latitude, longitude, exif: data ? jsonSafe(data) as Record<string, unknown> : null };
  } catch {
    return { capturedAt: null, latitude: null, longitude: null, exif: null };
  }
}
