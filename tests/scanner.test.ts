import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoStore } from '../src/db.js';
import type { PhotoRecord } from '../src/types.js';

const fixture = vi.hoisted(() => ({ root: '', store: null as PhotoStore | null, photos: [] as PhotoRecord[], limit: 36, assess: vi.fn() }));
const metrics = { width: 1600, height: 900, orientation: 'landscape', technicalScore: 85, brightness: .5, sharpness: 100, darkFraction: .01, lightFraction: .01, visualHash: 'a', perceptualHash: 'a' };
const assessment = { quality: 85, composition: 80, aesthetics: 82, story: 80, summary: '可见瞬间', observations: ['主体清晰'], theme: '人物活动', reason: '主体和动作清晰' };

vi.mock('../src/config.js', () => ({ config: { get PHOTO_ROOT() { return fixture.root; }, FILE_SETTLE_SECONDS: 0, get MAX_SCORING_PHOTOS_PER_RUN() { return fixture.limit; }, VISION_API_URL: 'https://example.test', VISION_MODEL: 'vision' } }));
vi.mock('../src/repository.js', () => ({
  get store() { return fixture.store!; },
  selectionPolicy: { minQuality: 60, minAesthetics: 65, minStory: 60, minComposition: 60, minTotal: 60, minTechnical: 50, minShortEdge: 500, maxImages: 6, duplicateDistance: 4 }
}));
vi.mock('../src/analysis.js', () => ({ ANALYSIS_VERSION: 'test', inspectImage: async () => ({ metrics, thumbnail: Buffer.from('thumbnail') }), makeAssessmentThumbnail: async () => Buffer.from('thumbnail'), assessStory: (...args: unknown[]) => fixture.assess(...args), totalScore: () => 82 }));
vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

async function photos(count: number) {
  const directory = path.join(fixture.root, 'new-photos');
  await fs.mkdir(directory);
  for (let i = 0; i < count; i++) {
    const filePath = path.join(directory, String(i).padStart(2, '0') + '.jpg');
    await fs.writeFile(filePath, 'fixture');
    const photo = fixture.store!.importPhoto({ filePath, fileHash: String(i), capturedAt: new Date(Date.UTC(2026, 7, 5, 16, 0, -i)).toISOString(), latitude: null, longitude: null, locationName: null, title: '', description: '' });
    fixture.store!.updateMetadata(photo.id, { capturedAt: photo.capturedAt, latitude: null, longitude: null, exif: { fixture: true } });
    const stat = await fs.stat(filePath);
    fixture.store!.cacheFile(filePath, stat.size, stat.mtimeMs, photo.id);
    fixture.photos.push(fixture.store!.getPhoto(photo.id)!);
  }
  return directory;
}

beforeEach(async () => {
  vi.resetModules();
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-status-'));
  fixture.store = new PhotoStore(':memory:'); fixture.photos = []; fixture.limit = 36;
  fixture.assess.mockReset().mockResolvedValue(assessment);
});
afterEach(async () => { fixture.store?.close(); await fs.rm(fixture.root, { recursive: true, force: true }); });

describe('live scanning and persistent continuation', () => {
  it('reports the active photo before its model response and caps a batch at 36', async () => {
    const directory = await photos(40);
    const { getScanStatus, scanPhotos, startScan } = await import('../src/scanner.js');
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    fixture.assess.mockImplementation(async () => { await response; return assessment; });
    const run = scanPhotos();
    try {
      await vi.waitFor(() => expect(fixture.assess).toHaveBeenCalledTimes(1));
      const status = getScanStatus();
      expect(status).toMatchObject({ running: true, phase: 'analyzing', analyzed: 0, currentIndex: 1, totalToAnalyze: 36 });
      expect(status.currentPhoto).toMatchObject({ photoId: fixture.photos[0].id, directory, fileName: '00.jpg' });
      status.currentPhoto!.fileName = 'changed snapshot';
      expect(getScanStatus().currentPhoto?.fileName).toBe('00.jpg');
      expect(startScan().accepted).toBe(false);
    } finally { release(); await run; }
    expect(getScanStatus()).toMatchObject({ running: false, phase: 'completed', analyzed: 36, currentIndex: 36 });
    expect(fixture.store!.listPhotos().filter(photo => photo.assessment)).toHaveLength(36);
    expect(fixture.store!.getScanCursor().photoId).toBe(fixture.photos[36].id);
  });

  it('stops an in-flight request without a failed attempt, survives restart, and resumes the same quota', async () => {
    fixture.limit = 3; await photos(5);
    let scanner = await import('../src/scanner.js');
    fixture.assess.mockImplementationOnce(async () => assessment).mockImplementationOnce(async (_image: Buffer, signal: AbortSignal) => {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const run = scanner.scanPhotos();
    await vi.waitFor(() => expect(fixture.assess).toHaveBeenCalledTimes(2));
    const cursor = fixture.store!.getScanCursor();
    expect(scanner.stopScan().accepted).toBe(true);
    await run;
    expect(scanner.getScanStatus()).toMatchObject({ running: false, phase: 'paused', analyzed: 1, errors: 0 });
    expect(fixture.store!.getScanCursor()).toEqual(cursor);
    expect(fixture.store!.getPhoto(fixture.photos[1].id)).toMatchObject({ analysisAttempts: 0, error: null, assessment: null });
    vi.resetModules(); scanner = await import('../src/scanner.js');
    expect(scanner.getScanStatus()).toMatchObject({ phase: 'paused', analyzed: 1, totalToAnalyze: 3 });
    await scanner.scanPhotos();
    expect(fixture.assess).toHaveBeenCalledTimes(2);
    expect(scanner.startScan().accepted).toBe(true);
    await scanner.scanPhotos();
    expect(scanner.getScanStatus()).toMatchObject({ phase: 'completed', analyzed: 3, totalToAnalyze: 3, errors: 0 });
    expect(fixture.photos.map(photo => fixture.store!.getPhoto(photo.id)?.analysisAttempts)).toEqual([1, 1, 1, 0, 0]);
    expect(fixture.assess).toHaveBeenCalledTimes(4);
  });

  it('does not move the cursor during successful or interrupted retries', async () => {
    fixture.limit = 1; await photos(3);
    const store = fixture.store!;
    store.setScanCursor(fixture.photos[1]);
    store.saveAnalysis(fixture.photos[0].id, { metrics: null, assessment: null, totalScore: null, status: 'needs_analysis', error: 'original timeout', analysisVersion: 'test', outcome: 'failed' });
    const scanner = await import('../src/scanner.js');
    fixture.assess.mockImplementationOnce(async (_image: Buffer, signal: AbortSignal) => {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const cursor = store.getScanCursor();
    const run = scanner.scanPhotos();
    await vi.waitFor(() => expect(fixture.assess).toHaveBeenCalledTimes(1));
    expect(scanner.getScanStatus().currentTask).toBe('retry');
    scanner.stopScan(); await run;
    expect(store.getPhoto(fixture.photos[0].id)).toMatchObject({ analysisAttempts: 1, error: 'original timeout' });
    scanner.startScan(); await scanner.scanPhotos();
    expect(store.getScanCursor()).toEqual(cursor);
    expect(store.getPhoto(fixture.photos[0].id)).toMatchObject({ analysisAttempts: 2, error: null });
  });

  it('can stop before discovery and continue without making a model call while stopped', async () => {
    fixture.limit = 1; await photos(2);
    const scanner = await import('../src/scanner.js');
    const run = scanner.scanPhotos(); scanner.stopScan(); await run;
    expect(scanner.getScanStatus().phase).toBe('paused');
    expect(fixture.assess).not.toHaveBeenCalled();
    scanner.startScan(); await scanner.scanPhotos();
    expect(fixture.assess).toHaveBeenCalledTimes(1);
    expect(scanner.getScanStatus()).toMatchObject({ analyzed: 1, phase: 'completed' });
  });

  it('moves a running cursor safely, replaces stale work and preserves the remaining quota', async () => {
    fixture.limit = 3; await photos(7);
    const scanner = await import('../src/scanner.js');
    fixture.assess.mockImplementationOnce(async () => assessment).mockImplementationOnce(async (_image: Buffer, signal: AbortSignal) => {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const run = scanner.scanPhotos();
    await vi.waitFor(() => expect(fixture.assess).toHaveBeenCalledTimes(2));
    const cursor = fixture.store!.getScanCursor();
    await expect(scanner.moveScanCursor(4, 8)).rejects.toThrow('照片队列已变化');
    expect(scanner.getScanStatus().running).toBe(true);
    expect(fixture.store!.getScanCursor()).toEqual(cursor);
    const moved = await scanner.moveScanCursor(2, 7);
    expect(moved).toMatchObject({ accepted: true, resumed: true });
    await run; await scanner.scanPhotos();
    expect(scanner.getScanStatus()).toMatchObject({ phase: 'completed', analyzed: 3, errors: 0 });
    expect(fixture.photos.map(photo => fixture.store!.getPhoto(photo.id)?.analysisAttempts)).toEqual([1, 0, 0, 0, 1, 1, 0]);
    expect(fixture.assess).toHaveBeenCalledTimes(4);
  });

  it('saves a stopped cursor across restart and skips green photos after moving back', async () => {
    fixture.limit = 2; await photos(5);
    let scanner = await import('../src/scanner.js');
    await scanner.scanPhotos();
    expect(fixture.assess).toHaveBeenCalledTimes(2);
    const moved = await scanner.moveScanCursor(4, 5);
    expect(moved).toMatchObject({ resumed: false, status: { phase: 'paused', analyzed: 0 } });
    vi.resetModules(); scanner = await import('../src/scanner.js');
    expect(scanner.getScanStatus().progress?.pointerIndex).toBe(4);
    await scanner.scanPhotos();
    expect(fixture.assess).toHaveBeenCalledTimes(2);
    scanner.startScan(); await scanner.scanPhotos();
    expect(fixture.photos.map(photo => fixture.store!.getPhoto(photo.id)?.analysisAttempts)).toEqual([1, 1, 1, 1, 0]);
    expect(fixture.assess).toHaveBeenCalledTimes(4);
  });

  it('replans a paused batch after moving without resetting its consumed quota', async () => {
    fixture.limit = 3; await photos(6);
    const scanner = await import('../src/scanner.js');
    fixture.assess.mockImplementationOnce(async () => assessment).mockImplementationOnce(async (_image: Buffer, signal: AbortSignal) => {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const run = scanner.scanPhotos();
    await vi.waitFor(() => expect(fixture.assess).toHaveBeenCalledTimes(2));
    scanner.stopScan(); await run;
    expect((await scanner.moveScanCursor(1, 6)).resumed).toBe(false);
    expect(scanner.getScanStatus()).toMatchObject({ phase: 'paused', analyzed: 1 });
    scanner.startScan(); await scanner.scanPhotos();
    expect(fixture.photos.map(photo => fixture.store!.getPhoto(photo.id)?.analysisAttempts)).toEqual([1, 0, 0, 0, 1, 1]);
    expect(scanner.getScanStatus()).toMatchObject({ phase: 'completed', analyzed: 3 });
  });

  it('keeps a manual score submitted while a retry model request is still running', async () => {
    await photos(1);
    const store = fixture.store!, photo = fixture.photos[0];
    store.saveAnalysis(photo.id, { metrics: { ...metrics, orientation: 'landscape' }, assessment: null, totalScore: null, status: 'needs_analysis', error: 'timeout', analysisVersion: 'test', outcome: 'failed' });
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    fixture.assess.mockImplementation(async () => { await response; return assessment; });
    const scanner = await import('../src/scanner.js');
    const run = scanner.scanPhotos();
    await vi.waitFor(() => expect(fixture.assess).toHaveBeenCalledTimes(1));
    const saved = store.updateManualScores(photo.id, { quality: 91, composition: 83, aesthetics: 95, story: 40, technicalScore: 90 }, 0,
      { minQuality: 60, minComposition: 60, minAesthetics: 65, minStory: 60, minTotal: 60, minTechnical: 50, minShortEdge: 500, maxImages: 6, duplicateDistance: 4 });
    release(); await run;
    expect(store.getPhoto(photo.id)).toEqual(saved);
    expect(store.getPhoto(photo.id)?.analysisAttempts).toBe(1);
  });
});
