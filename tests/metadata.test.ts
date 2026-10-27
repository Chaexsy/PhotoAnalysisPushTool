import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readMetadata } from '../src/metadata.js';

describe('metadata', () => {
  it('returns empty metadata for an unreadable file', async () => {
    await expect(readMetadata(path.join('missing', 'photo.jpg'))).resolves.toEqual({ capturedAt: null, latitude: null, longitude: null, exif: null });
  });
});
