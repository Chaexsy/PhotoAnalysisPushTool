import { describe, expect, it } from 'vitest';
import { batchFrom, distanceMeters, hashDistance, planBatches, rejectionReason, validateSelection, type SelectionPolicy } from '../src/selection.js';
import type { PhotoRecord, ShootingEvent } from '../src/types.js';

const policy: SelectionPolicy = { minQuality: 60, minAesthetics: 65, minStory: 60, minComposition: 60, minTotal: 60, minTechnical: 50, minShortEdge: 500, maxImages: 6, duplicateDistance: 4 };
const event: ShootingEvent = { id: 1, startAt: '2026-01-01T10:00:00.000Z', endAt: '2026-01-01T11:00:00.000Z', latitude: 31.2, longitude: 121.5, locationName: '上海 · 外滩', usedPosts: 0 };
function photo(id: number, orientation: 'landscape' | 'portrait', score = 80): PhotoRecord {
  return { id, filePath: `/photos/${id}.jpg`, fileHash: String(id).padStart(64, '0'), capturedAt: event.startAt, latitude: event.latitude, longitude: event.longitude,
    locationName: event.locationName, title: 'x', description: 'x', status: 'pending', publishedAt: null, remoteUrl: null, error: null, eventId: event.id,
    metrics: { width: orientation === 'landscape' ? 1600 : 900, height: orientation === 'landscape' ? 900 : 1600, orientation, visualHash: id.toString(16).padStart(64, 'a'), perceptualHash: (["0000000000000000", "ffffffffffffffff", "aaaaaaaaaaaaaaaa", "5555555555555555"][id - 1] ?? id.toString(16).padStart(16, '0')), technicalScore: 80, brightness: .5, sharpness: 100, darkFraction: .01, lightFraction: .01 },
    assessment: { quality: score, composition: score, aesthetics: score, story: score, summary: `瞬间 ${id}`, observations: ['画面有明确主体'], theme: '人物活动', reason: '可见主体和动作' }, totalScore: score, analysisVersion: 'test' };
}

describe('photo selection rules', () => {
  it('computes event distance and perceptual distance', () => {
    expect(distanceMeters({ latitude: 31.2, longitude: 121.5 }, { latitude: 31.2001, longitude: 121.5 })).toBeGreaterThan(0);
    expect(hashDistance('0000000000000000', '000000000000000f')).toBe(4);
  });
  it('never mixes orientation and enforces the three-post quota', () => {
    const batches = planBatches([photo(1, 'landscape'), photo(2, 'landscape'), photo(3, 'portrait'), photo(4, 'portrait')], [event], policy);
    expect(batches).toHaveLength(2);
    expect(new Set(batches.map(b => b.orientation))).toEqual(new Set(['landscape', 'portrait']));
    expect(() => validateSelection([photo(1, 'landscape'), photo(3, 'portrait')], [photo(1, 'landscape'), photo(3, 'portrait')], event, policy)).toThrow('横图和竖图不能混发');
    expect(planBatches([photo(1, 'landscape')], [{ ...event, usedPosts: 3 }], policy)).toHaveLength(0);
  });
  it('rejects square, low-scoring, and missing analysis photos', () => {
    expect(rejectionReason({ ...photo(1, 'landscape'), metrics: { ...photo(1, 'landscape').metrics!, orientation: 'square' } }, policy)).toContain('正方形');
    expect(rejectionReason({ ...photo(1, 'landscape'), assessment: null }, policy)).toContain('视觉模型');
    expect(rejectionReason({ ...photo(1, 'landscape', 30) }, policy)).toContain('视觉质量');
    const lowAesthetic = photo(1, 'landscape');
    lowAesthetic.assessment = { ...lowAesthetic.assessment!, aesthetics: 40 };
    expect(rejectionReason(lowAesthetic, policy)).toContain('美学价值');
  });
  it('keeps low story scores eligible when the weighted total passes', () => {
    const lowStory = photo(1, 'landscape');
    lowStory.assessment = { ...lowStory.assessment!, story: 10 };
    lowStory.totalScore = 66;
    expect(rejectionReason(lowStory, policy)).toBeNull();
  });
  it('limits generated draft copy to 50 characters', () => {
    const candidate = photo(1, 'landscape');
    candidate.assessment!.summary = '长'.repeat(80);
    expect(batchFrom([candidate], event).description).toHaveLength(50);
  });
  it('blocks a photo hash already used by a published note', () => {
    const used = photo(1, 'landscape');
    const candidate = { ...photo(2, 'landscape'), fileHash: used.fileHash };
    expect(planBatches([used, { ...candidate, status: 'published' }, candidate], [event], policy)).toHaveLength(0);
  });
});
