import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAssessment, assessStory } from '../src/analysis.js';
import { config } from '../src/config.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('vision assessment parsing', () => {
  it('accepts a fenced response with numeric words from an otherwise strict model', () => {
    const value = parseAssessment('```json\n{"quality": fifty, "composition": 60, "story": thirty?, "aesthetics": 70, "summary":"画面", "observations":["主体清晰"], "theme":"自然风景", "reason":"光线自然"}\n```');
    expect(value.quality).toBe(50);
    expect(value.story).toBe(30);
  });
  it('propagates a manual stop to the HTTP request instead of waiting for its timeout', async () => {
    const originalUrl = config.VISION_API_URL, originalModel = config.VISION_MODEL;
    config.VISION_API_URL = 'https://example.test/chat/completions'; config.VISION_MODEL = 'test';
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      requestSignal = options.signal;
      await new Promise((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true }));
    }));
    try {
      const controller = new AbortController();
      const pending = assessStory(Buffer.from('test'), controller.signal);
      const stopped = expect(pending).rejects.toThrow('manual stop');
      controller.abort(new Error('manual stop'));
      await stopped;
      expect(requestSignal?.aborted).toBe(true);
    } finally { config.VISION_API_URL = originalUrl; config.VISION_MODEL = originalModel; }
  });
});
