import { describe, expect, it } from 'vitest';
import { PhotoStore } from '../src/db.js';
import type { ImageMetrics } from '../src/types.js';
import type { SelectionPolicy } from '../src/selection.js';

const policy: SelectionPolicy = { minQuality: 60, minComposition: 60, minAesthetics: 65, minStory: 60, minTotal: 60, minTechnical: 50, minShortEdge: 500, maxImages: 6, duplicateDistance: 4 };
const metrics: ImageMetrics = { width: 1600, height: 900, orientation: 'landscape', technicalScore: 85, brightness: .5, sharpness: 100, darkFraction: .01, lightFraction: .01, visualHash: 'a', perceptualHash: 'a' };
const assessment = { quality: 85, composition: 80, aesthetics: 82, story: 80, summary: '可见瞬间', observations: ['主体清晰'], theme: '人物活动' as const, reason: '主体和动作清晰' };
const scores = { technicalScore: 80, quality: 90, composition: 70, aesthetics: 95, story: 40 };
function add(store: PhotoStore, state: 'assessed' | 'failed' | 'skipped' | 'unscanned' = 'assessed', capturedAt: string | null = '2026-01-01T10:00:00Z') {
  const photo = store.importPhoto({ filePath: '/photo.jpg', fileHash: 'photo', capturedAt, latitude: null, longitude: null, locationName: null, title: '', description: '' });
  if (state !== 'unscanned') store.saveAnalysis(photo.id, { metrics, assessment: state === 'assessed' ? assessment : null, totalScore: state === 'assessed' ? 82 : null,
    status: state === 'failed' ? 'needs_analysis' : state === 'skipped' ? 'rejected' : 'pending', error: state === 'assessed' ? null : 'original reason', analysisVersion: 'model-v1', outcome: state });
  return store.getPhoto(photo.id)!;
}

describe('manual photo scores', () => {
  it('recalculates the weighted total and eligibility without changing model text or consuming an attempt', () => {
    const store = new PhotoStore(':memory:');
    try {
      const photo = add(store);
      const saved = store.updateManualScores(photo.id, scores, 0, policy);
      expect(saved).toMatchObject({ totalScore: 77, scoreRevision: 1, status: 'pending', analysisAttempts: 1, analysisAttemptedAt: photo.analysisAttemptedAt, analysisVersion: 'model-v1' });
      expect(saved.manualScoresAt).toBeTruthy();
      expect(saved.assessment).toEqual({ ...assessment, ...Object.fromEntries(Object.entries(scores).filter(([key]) => key !== 'technicalScore')) });
      const low = store.updateManualScores(photo.id, { ...scores, aesthetics: 50 }, 1, policy);
      expect(low).toMatchObject({ totalScore: 63, status: 'rejected', error: '美学价值评分不足', analysisOutcome: 'assessed', analysisAttempts: 1 });
      expect(store.scanCandidates(10)).toEqual([]);
    } finally { store.close(); }
  });

  it('rejects invalid, incomplete and stale edits atomically', () => {
    const store = new PhotoStore(':memory:');
    try {
      const photo = add(store, 'unscanned');
      expect(() => store.updateManualScores(photo.id, scores, 0, policy)).toThrow('尚未完成扫描');
      store.saveAnalysis(photo.id, { metrics, assessment, totalScore: 82, status: 'pending', error: null, analysisVersion: 'v1' });
      const baseline = store.getPhoto(photo.id);
      for (const value of [null, {}, { ...scores, quality: '85' }, { ...scores, quality: -1 }, { ...scores, quality: 101 }, { ...scores, quality: NaN }, { ...scores, quality: Infinity }]) {
        expect(() => store.updateManualScores(photo.id, value, 0, policy)).toThrow('全部五项评分');
        expect(store.getPhoto(photo.id)).toEqual(baseline);
      }
      const saved = store.updateManualScores(photo.id, scores, 0, policy);
      expect(() => store.updateManualScores(photo.id, { ...scores, quality: 20 }, 0, policy)).toThrow('评分已被修改');
      expect(store.getPhoto(photo.id)).toEqual(saved);
    } finally { store.close(); }
  });

  it('allows completing failed or technically skipped scores and protects them from late model results', () => {
    for (const outcome of ['failed', 'skipped'] as const) {
      const store = new PhotoStore(':memory:');
      try {
        const photo = add(store, outcome, null);
        const saved = store.updateManualScores(photo.id, scores, 0, policy);
        expect(saved).toMatchObject({ status: 'needs_metadata', analysisOutcome: 'assessed', totalScore: 77, analysisAttempts: 1, assessment: { observations: [] } });
        store.saveAnalysis(photo.id, { metrics, assessment, totalScore: 82, status: 'pending', error: null, analysisVersion: 'late-response' });
        expect(store.getPhoto(photo.id)).toEqual(saved);
        expect(store.scanCandidates(10)).toEqual([]);
      } finally { store.close(); }
    }
  });

  it('keeps publication status, errors and references intact when changing scores', () => {
    const store = new PhotoStore(':memory:');
    try {
      const photo = add(store);
      store.db.prepare("UPDATE photos SET status='published',remote_url='https://example/post',published_at='2026-01-02T00:00:00Z',error='publication note' WHERE id=?").run(photo.id);
      const saved = store.updateManualScores(photo.id, { ...scores, quality: 0 }, 0, policy);
      expect(saved).toMatchObject({ status: 'published', error: 'publication note', remoteUrl: 'https://example/post', publishedAt: '2026-01-02T00:00:00Z', assessment: { quality: 0 } });
    } finally { store.close(); }
  });
});
