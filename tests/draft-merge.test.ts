import { describe, expect, it } from 'vitest';
import { PhotoStore } from '../src/db.js';
import type { SelectionPolicy } from '../src/selection.js';
import type { PhotoRecord, PostRecord } from '../src/types.js';

const policy: SelectionPolicy = { minQuality: 60, minAesthetics: 65, minStory: 60, minComposition: 60, minTotal: 60, minTechnical: 50, minShortEdge: 500, maxImages: 6, duplicateDistance: 4 };
function add(store: PhotoStore, day: number, theme: '人物活动' | '动物观察' = '人物活动', orientation: 'landscape' | 'portrait' = 'landscape') {
  const index = store.listPhotos().length;
  const photo = store.importPhoto({ filePath: `/photos/${index}.jpg`, fileHash: `hash-${index}`, capturedAt: `2026-01-${String(day).padStart(2, '0')}T10:00:00Z`, latitude: 30 + day, longitude: 120, locationName: `地点 ${day}`, title: '', description: '' });
  store.saveAnalysis(photo.id, { metrics: { width: orientation === 'landscape' ? 1600 : 900, height: orientation === 'landscape' ? 900 : 1600, orientation, technicalScore: 90, brightness: .5, sharpness: 100, darkFraction: 0, lightFraction: 0, visualHash: `visual-${index}`, perceptualHash: `test-hash-${index}` }, assessment: { quality: 90, aesthetics: 90, composition: 90, story: 70, summary: `照片 ${index}`, observations: ['主体清晰'], theme, reason: '适合发布' }, totalScore: 85, status: 'pending', error: null, analysisVersion: 'test' });
  return store.getPhoto(photo.id)!;
}
function sources(drafts: PostRecord[]) { return drafts.map(({ id, revision }) => ({ id, revision })); }
function fixture() {
  const store = new PhotoStore(':memory:');
  const photos = [add(store, 1), add(store, 1), add(store, 2, '动物观察'), add(store, 2, '动物观察'), add(store, 3, '人物活动', 'portrait')];
  store.groupPhotos(6, 300); store.ensureDrafts(policy);
  return { store, photos: photos.map(photo => store.getPhoto(photo.id)!), drafts: store.listDrafts() };
}

describe('merging queued drafts', () => {
  it('merges chosen photos across events and themes and preserves copy, metadata and order', () => {
    const { store, photos, drafts } = fixture();
    try {
      const first = store.updateDraft(drafts[0].id, drafts[0].photoIds, policy, { topics: ['摄影'], verifiedTopics: ['摄影'], scheduledAt: '2026-11-01T13:00:00Z', locationTag: '地点甲', locationVerified: true });
      const merged = store.mergeDrafts(sources([first, drafts[1]]), [photos[2].id, photos[0].id], policy, { title: '', description: '文'.repeat(60) });
      expect(merged).toMatchObject({ id: first.id, status: 'draft', merged: true, title: '', description: '文'.repeat(50), theme: '综合', orientation: 'landscape', eventId: photos[2].eventId, locationTag: null, locationVerified: false, topics: ['摄影'], verifiedTopics: ['摄影'], scheduledAt: '2026-11-01T13:00:00.000Z' });
      expect(merged.photoIds).toEqual([photos[2].id, photos[0].id]);
      expect(new Set(merged.eventIds)).toEqual(new Set([photos[0].eventId, photos[2].eventId]));
      expect(store.listDrafts()).toHaveLength(2);
      expect(store.getPhoto(photos[1].id)?.status).toBe('pending');
      expect(store.getPhoto(photos[3].id)?.assessment).toEqual(photos[3].assessment);
      expect(store.previewDraft(merged.id, policy).theme).toBe('综合');
      const reserved = store.reserveDraft(merged.id, policy);
      expect(reserved.batch.theme).toBe('综合');
      expect(reserved.batch.photos.map(photo => photo.id)).toEqual(merged.photoIds);
      for (const id of merged.eventIds) expect(store.listEvents().find(event => event.id === id)?.usedPosts).toBe(1);
      expect(store.ensureDrafts(policy)).toBe(2); // Only the two unselected photos are available again.
      expect(store.listDrafts().flatMap(draft => draft.photoIds)).not.toContain(photos[0].id);
    } finally { store.close(); }
  });

  it('allows further editing and remerging while keeping the current events accurate', () => {
    const { store, photos, drafts } = fixture();
    try {
      const merged = store.mergeDrafts(sources(drafts.slice(0, 2)), [photos[0].id, photos[2].id], policy);
      const edited = store.updateDraft(merged.id, [photos[2].id], policy, { title: '合并后调整', description: '很短的文案' });
      expect(edited.eventIds).toEqual([photos[2].eventId]);
      expect(edited.eventId).toBe(photos[2].eventId);
      expect(edited.theme).toBe('动物观察');
      const remerged = store.mergeDrafts(sources([edited, store.listDrafts().find(draft => draft.id !== merged.id)!]), [photos[2].id], policy);
      expect(store.listDrafts()).toHaveLength(1);
      expect(remerged.photoIds).toEqual([photos[2].id]);
      store.reserveDraft(remerged.id, policy);
    } finally { store.close(); }
  });

  it('rejects mixed orientations, invalid sources, duplicate or unrelated photos without changing originals', () => {
    const { store, photos, drafts } = fixture();
    try {
      const before = store.listPosts();
      const attempts: [() => unknown, string][] = [
        [() => store.mergeDrafts(sources([drafts[0]]), [photos[0].id], policy), '2 到 100'],
        [() => store.mergeDrafts(sources([drafts[0], drafts[0]]), [photos[0].id], policy), '重复选择'],
        [() => store.mergeDrafts(sources(drafts), [photos[0].id, photos[4].id], policy), '横图和竖图'],
        [() => store.mergeDrafts(sources(drafts.slice(0, 2)), [], policy), '1 到 6'],
        [() => store.mergeDrafts(sources(drafts.slice(0, 2)), [photos[0].id, photos[0].id], policy), '编号无效或重复'],
        [() => store.mergeDrafts(sources(drafts.slice(0, 2)), [photos[4].id], policy), '所选草稿中的照片'],
        [() => store.mergeDrafts(sources(drafts.slice(0, 2)), [photos[0].id], policy, { scheduledAt: 'invalid' }), '时间格式无效']
      ];
      for (const [action, message] of attempts) { expect(action).toThrow(message); expect(store.listPosts()).toEqual(before); }
      expect(() => store.mergeDrafts(sources(drafts), photos.map(photo => photo.id), { ...policy, maxImages: 2 })).toThrow('1 到 2');
    } finally { store.close(); }
  });

  it('rejects stale edits, rescheduled drafts and repeat submissions', () => {
    const { store, photos, drafts } = fixture();
    try {
      store.updateDraft(drafts[0].id, drafts[0].photoIds, policy, { title: '另一个窗口修改' });
      expect(() => store.mergeDrafts(sources(drafts.slice(0, 2)), [photos[0].id], policy)).toThrow('已被修改');
      const current = store.listDrafts();
      store.scheduleDrafts(['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z'], true);
      expect(() => store.mergeDrafts(sources(current.slice(0, 2)), [photos[0].id], policy)).toThrow('已被修改');
      const fresh = sources(store.listDrafts().slice(0, 2));
      store.mergeDrafts(fresh, [photos[0].id], policy);
      const merged = store.listPosts();
      expect(() => store.mergeDrafts(fresh, [photos[0].id], policy)).toThrow();
      expect(store.listPosts()).toEqual(merged);
    } finally { store.close(); }
  });

  it('keeps normal draft rules strict and checks every source event quota again at reservation', () => {
    const { store, photos, drafts } = fixture();
    try {
      expect(() => store.updateDraft(drafts[0].id, [photos[0].id, photos[2].id], policy)).toThrow();
      const merged = store.mergeDrafts(sources(drafts.slice(0, 2)), [photos[0].id, photos[2].id], policy);
      const otherPhotos: PhotoRecord[] = [add(store, 2), add(store, 2), add(store, 2)];
      store.groupPhotos(6, 300);
      for (const photo of otherPhotos) {
        const reserved = store.reserve([photo.id], policy);
        store.finishPost(reserved.postId, 'published', null, null);
      }
      expect(() => store.reserveDraft(merged.id, policy)).toThrow('三次发布配额');
      expect(store.listDrafts().find(draft => draft.id === merged.id)?.photoIds).toEqual(merged.photoIds);
      expect(store.getPhoto(photos[0].id)?.status).toBe('pending');
    } finally { store.close(); }
  });

  it('blocks duplicate photographs and preserves a shared verified location', () => {
    const { store, photos, drafts } = fixture();
    try {
      const shared = drafts.slice(0, 2).map(draft => store.updateDraft(draft.id, draft.photoIds, policy, { locationTag: '共同地点', locationVerified: true }));
      store.db.prepare('UPDATE photos SET metrics_json=? WHERE id=?').run(JSON.stringify(photos[0].metrics), photos[2].id);
      expect(() => store.mergeDrafts(sources(shared), [photos[0].id, photos[2].id], policy)).toThrow('重复或近似');
      const merged = store.mergeDrafts(sources(shared), [photos[0].id, photos[3].id], policy);
      expect(merged.locationTag).toBe('共同地点');
      expect(merged.locationVerified).toBe(true);
    } finally { store.close(); }
  });
});
