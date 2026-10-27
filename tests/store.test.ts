import { describe, expect, it } from 'vitest';
import { PhotoStore } from '../src/db.js';
import type { SelectionPolicy } from '../src/selection.js';

const policy: SelectionPolicy = { minQuality: 60, minAesthetics: 65, minStory: 60, minComposition: 60, minTotal: 60, minTechnical: 50, minShortEdge: 500, maxImages: 6, duplicateDistance: 4 };
const metrics = (id: number) => ({ width: 1600, height: 900, orientation: 'landscape' as const, visualHash: String(id).padStart(64, '0'), perceptualHash: ['0000000000000000', 'ffffffffffffffff', '3333333333333333', 'cccccccccccccccc'][id], technicalScore: 90, brightness: .5, sharpness: 100, darkFraction: .01, lightFraction: .01 });
const assessment = (id: number) => ({ quality: 85, composition: 80, aesthetics: 82, story: 80, summary: `可见瞬间 ${id}`, observations: ['有明确主体'], theme: '人物活动' as const, reason: '主体和动作清晰' });

describe('PhotoStore publication invariants', () => {
  it('analyzes newest capture times first regardless of import or retry order, with undated photos last', () => {
    const store = new PhotoStore(':memory:');
    try {
      const add = (name: string, capturedAt: string | null, modifiedAt: string) => {
        const photo = store.importPhoto({ filePath: `/photos/${name}.jpg`, fileHash: name, capturedAt, latitude: null, longitude: null, locationName: null, title: name, description: '' });
        store.cacheFile(photo.filePath, 100, Date.parse(modifiedAt), photo.id);
        return photo;
      };
      const newest = add('newest', '2026-08-05T16:00:00+08:00', '2026-08-06T00:00:00Z');
      const older = add('older', '2026-08-01T00:00:00Z', '2026-10-14T00:00:00Z');
      const middle = add('middle', '2026-08-05T07:00:00Z', '2026-08-06T00:00:00Z');
      const undatedOld = add('undated-old', null, '2026-09-01T00:00:00Z');
      const undatedNew = add('undated-new', null, '2026-10-14T00:00:00Z');
      const assessed = add('assessed', '2026-10-01T00:00:00Z', '2026-10-14T00:00:00Z');
      store.saveAnalysis(newest.id, { metrics: metrics(0), assessment: null, totalScore: null, status: 'needs_analysis', error: 'model timeout', analysisVersion: 'test', outcome: 'failed' });
      store.saveAnalysis(assessed.id, { metrics: metrics(1), assessment: assessment(1), totalScore: 82, status: 'needs_metadata', error: null, analysisVersion: 'test' });
      expect(store.analysisQueue().map(photo => photo.id)).toEqual([newest.id, middle.id, older.id, undatedNew.id, undatedOld.id]);
    } finally { store.close(); }
  });

  it('only prioritizes failures newer than the cursor and preserves the normal sweep order', () => {
    const store = new PhotoStore(':memory:');
    try {
      const photos = [1, 2, 3, 4, 5].map(day => store.importPhoto({ filePath: `/frontier-${day}.jpg`, fileHash: `frontier-${day}`, capturedAt: `2026-01-0${day}T10:00:00Z`, latitude: null, longitude: null, locationName: null, title: '', description: '' }));
      const failure = { metrics: null, assessment: null, totalScore: null, status: 'needs_analysis' as const, error: 'timeout', analysisVersion: 'test', outcome: 'failed' as const };
      store.saveAnalysis(photos[0].id, failure);
      store.saveAnalysis(photos[3].id, failure);
      for (const index of [2, 4]) store.saveAnalysis(photos[index].id, { metrics: metrics(0), assessment: assessment(0), totalScore: 82, status: 'pending', error: null, analysisVersion: 'test' });
      store.setScanCursor(photos[2]);
      expect(store.scanWork(10).map(item => [item.photo.id, item.mode])).toEqual([
        [photos[3].id, 'retry'], [photos[1].id, 'scan'], [photos[0].id, 'scan']
      ]);
      const before = store.getScanCursor();
      store.saveAnalysis(photos[3].id, failure);
      expect(store.getScanCursor()).toEqual(before);
      store.advanceScanCursor(photos[3]);
      expect(store.getScanCursor()).toEqual(before);
      store.advanceScanCursor(photos[1]);
      expect(store.getScanCursor().photoId).toBe(photos[0].id);
      expect(store.scanWork(10).find(item => item.photo.id === photos[0].id)?.mode).toBe('scan');
      store.advanceScanCursor(photos[0]);
      expect(store.getScanCursor().photoId).toBe(0);
      expect(store.scanProgress().pointerIndex).toBe(0);
      expect(store.scanWork(10).find(item => item.photo.id === photos[0].id)?.mode).toBe('retry');
    } finally { store.close(); }
  });

  it('resets a misplaced cursor to the completed tail without resetting scores or attempts', () => {
    const store = new PhotoStore(':memory:');
    try {
      const photos = [1, 2, 3, 4].map(day => store.importPhoto({ filePath: `/reset-${day}.jpg`, fileHash: `reset-${day}`, capturedAt: `2026-01-0${day}T10:00:00Z`, latitude: null, longitude: null, locationName: null, title: '', description: '' }));
      store.saveAnalysis(photos[0].id, { metrics: null, assessment: null, totalScore: null, status: 'needs_analysis', error: 'timeout', analysisVersion: 'test', outcome: 'failed' });
      for (const index of [2, 3]) store.saveAnalysis(photos[index].id, { metrics: metrics(0), assessment: assessment(0), totalScore: 82, status: 'pending', error: null, analysisVersion: 'test' });
      store.setScanCursor(photos[0]);
      store.resetScanCursorToCompletedTail();
      expect(store.getScanCursor().photoId).toBe(photos[2].id);
      expect(store.getScanSession()).toEqual({ paused: true, session: null });
      expect(store.getPhoto(photos[0].id)?.analysisAttempts).toBe(1);
      expect(store.getPhoto(photos[3].id)?.totalScore).toBe(82);
      expect(store.scanCandidates(10).map(photo => photo.id)).toEqual([photos[1].id, photos[0].id]);
    } finally { store.close(); }
  });

  it('orders equal instants consistently and filters unavailable files before applying the limit', () => {
    const store = new PhotoStore(':memory:');
    try {
      const add = (name: string, capturedAt: string | null) => store.importPhoto({ filePath: `/${name}.jpg`, fileHash: name, capturedAt, latitude: null, longitude: null, locationName: null, title: '', description: '' });
      const oldest = add('undated', null);
      const early = add('early', '2026-08-05T07:00:00Z');
      const equal1 = add('equal1', '2026-08-05T16:00:00+08:00');
      const equal2 = add('equal2', '2026-08-05T08:00:00.000Z');
      expect(store.scanCandidates(10).map(photo => photo.id)).toEqual([equal2.id, equal1.id, early.id, oldest.id]);
      expect(store.scanWork(1, new Set([early.id])).map(item => item.photo.id)).toEqual([early.id]);
      store.setScanCursor(early);
      expect(store.scanWork(10).map(item => [item.photo.id, item.mode])).toEqual([
        [equal2.id, 'new'], [equal1.id, 'new'], [early.id, 'scan'], [oldest.id, 'scan']
      ]);
    } finally { store.close(); }
  });

  it('resolves dragged positions chronologically and respects a manual start while skipping successes', () => {
    const store = new PhotoStore(':memory:');
    try {
      expect(() => store.scanCursorTarget(0, 0)).toThrow('指针位置无效');
      const photos = [1, 2, 3, 4, 5].map(day => store.importPhoto({ filePath: `/manual-${day}.jpg`, fileHash: `manual-${day}`, capturedAt: `2026-01-0${day}T10:00:00Z`, latitude: null, longitude: null, locationName: null, title: '', description: '' }));
      for (const index of [-1, 5, 1.5, NaN]) expect(() => store.scanCursorTarget(index, 5)).toThrow('指针位置无效');
      expect(() => store.scanCursorTarget(0, 4)).toThrow('照片队列已变化');
      expect(store.scanCursorTarget(0, 5).id).toBe(photos[0].id);
      expect(store.scanCursorTarget(4, 5).id).toBe(photos[4].id);
      store.saveAnalysis(photos[4].id, { metrics: null, assessment: null, totalScore: null, status: 'needs_analysis', error: 'timeout', analysisVersion: 'test', outcome: 'failed' });
      store.saveAnalysis(photos[1].id, { metrics: metrics(1), assessment: assessment(1), totalScore: 50, status: 'rejected', error: '评分不足', analysisVersion: 'test' });
      store.setManualScanCursor(store.scanCursorTarget(2, 5));
      expect(store.scanWork(10).map(item => [item.photo.id, item.mode])).toEqual([
        [photos[4].id, 'retry'], [photos[2].id, 'scan'], [photos[0].id, 'scan']
      ]);
      expect(store.scanProgress().pointerIndex).toBe(2);
      store.advanceScanCursor(photos[2]);
      expect(store.scanWork(10).map(item => item.photo.id)).toEqual([photos[4].id, photos[0].id]);
      expect(store.getPhoto(photos[1].id)?.analysisAttempts).toBe(1);
    } finally { store.close(); }
  });

  it('persists an event quota and blocks the fourth post', () => {
    const store = new PhotoStore(':memory:');
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const photo = store.importPhoto({ filePath: `/photo-${i}.jpg`, fileHash: String(i).padStart(64, '0'), capturedAt: `2026-01-01T10:0${i}:00.000Z`, latitude: 31.2, longitude: 121.5, locationName: '上海 · 外滩', title: '照片', description: '照片' });
      ids.push(photo.id);
      store.saveAnalysis(photo.id, { metrics: metrics(i), assessment: assessment(i), totalScore: 82, status: 'pending', error: null, analysisVersion: 'test' });
    }
    store.groupPhotos(6, 300);
    for (let i = 0; i < 3; i++) {
      const reserved = store.reserve([ids[i]], policy);
      store.finishPost(reserved.postId, 'published', `https://example/${i}`, null);
    }
    expect(store.listEvents()[0].usedPosts).toBe(3);
    expect(() => store.reserve([ids[3]], policy)).toThrow('三次发布配额');
    store.close();
  });

  it('creates idempotent drafts and allows editing before reservation', () => {
    const store = new PhotoStore(':memory:');
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      const photo = store.importPhoto({ filePath: `/draft-${i}.jpg`, fileHash: `draft-${String(i).padStart(60, '0')}`, capturedAt: `2026-01-02T10:0${i}:00.000Z`, latitude: 31.2, longitude: 121.5, locationName: '上海 · 外滩', title: '照片', description: '默认文案' });
      ids.push(photo.id);
      store.saveAnalysis(photo.id, { metrics: metrics(i), assessment: assessment(i), totalScore: 82, status: 'pending', error: null, analysisVersion: 'test' });
    }
    store.groupPhotos(6, 300);
    expect(store.ensureDrafts(policy)).toBe(2);
    expect(store.ensureDrafts(policy)).toBe(0);
    const draft = store.listDrafts()[0];
    const editedPhotoIds = draft.photoIds.slice(0, 2);
    const edited = store.updateDraft(draft.id, editedPhotoIds, policy, '', 'x'.repeat(60));
    expect(edited.title).toBe('');
    expect(edited.description).toHaveLength(50);
    expect(edited.photoIds).toEqual(editedPhotoIds);
    const reserved = store.reserveDraft(draft.id, policy);
    expect(store.listPosts().find(post => post.id === reserved.postId)?.status).toBe('publishing');
    expect(store.getPhoto(editedPhotoIds[0])?.status).toBe('publishing');
    store.releasePostToDraft(reserved.postId);
    expect(store.listPosts().find(post => post.id === reserved.postId)?.status).toBe('draft');
    expect(store.getPhoto(editedPhotoIds[0])?.status).toBe('pending');
    store.close();
  });

  it('groups photos without GPS by capture time and omits a fabricated location', () => {
    const store = new PhotoStore(':memory:');
    try {
      const first = store.importPhoto({ filePath: '/time-only-1.jpg', fileHash: 'time-only-1', capturedAt: '2026-01-03T10:00:00.000Z', latitude: null, longitude: null, locationName: null, title: '照片', description: '' });
      const second = store.importPhoto({ filePath: '/time-only-2.jpg', fileHash: 'time-only-2', capturedAt: '2026-01-03T10:20:00.000Z', latitude: null, longitude: null, locationName: null, title: '照片', description: '' });
      for (const photo of [first, second]) store.saveAnalysis(photo.id, { metrics: metrics(photo.id + 10), assessment: assessment(photo.id + 10), totalScore: 82, status: 'pending', error: null, analysisVersion: 'test' });
      store.groupPhotos(6, 300);
      const event = store.listEvents()[0];
      expect(event.latitude).toBeNull();
      expect(event.longitude).toBeNull();
      expect(store.eventPhotos(event.id).map(photo => photo.id)).toEqual([first.id, second.id]);
      expect(store.ensureDrafts(policy)).toBe(1);
      expect(store.listDrafts()[0].description).not.toContain('拍摄地点：');
    } finally { store.close(); }
  });

  it('records an XHS draft save separately from final publication and supports manual resolution', () => {
    const store = new PhotoStore(':memory:');
    try {
      const photo = store.importPhoto({ filePath: '/saved-draft.jpg', fileHash: 'saved-draft', capturedAt: '2026-01-04T10:00:00.000Z', latitude: 31.2, longitude: 121.5, locationName: '上海 · 外滩', title: '照片', description: '' });
      store.saveAnalysis(photo.id, { metrics: metrics(0), assessment: assessment(0), totalScore: 82, status: 'pending', error: null, analysisVersion: 'test' });
      store.groupPhotos(6, 300);
      expect(store.ensureDrafts(policy)).toBe(1);
      const draft = store.listDrafts()[0];
      const reserved = store.reserveDraft(draft.id, policy);
      store.finishPost(reserved.postId, 'draft_saved', null, null);
      store.recordXhsDraftEvidence(reserved.postId, { draftId: 'original-xhs-draft', account: '旅行者' });
      const saved = store.listPosts().find(post => post.id === reserved.postId)!;
      expect(saved.status).toBe('draft_saved');
      expect(saved.xhsDraftId).toBe('original-xhs-draft');
      expect(saved.xhsDraftStorage).toBe('browser_local');
      expect(saved.draftSavedAt).toBeTruthy();
      expect(saved.publishedAt).toBeNull();
      expect(store.listDrafts()).toHaveLength(0);
      expect(store.getPhoto(photo.id)?.status).toBe('draft_saved');
      expect(store.listEvents()[0].usedPosts).toBe(1);

      store.resolvePost(reserved.postId, false, null);
      expect(store.listDrafts()).toHaveLength(1);
      expect(store.listDrafts()[0].xhsDraftId).toBeNull();
      expect(store.getPhoto(photo.id)?.status).toBe('pending');

      const second = store.reserveDraft(store.listDrafts()[0].id, policy);
      store.finishPost(second.postId, 'draft_saved', null, null);
      store.resolvePost(second.postId, true, 'https://www.xiaohongshu.com/explore/test');
      const published = store.listPosts().find(post => post.id === second.postId)!;
      expect(published.status).toBe('published');
      expect(published.publishedAt).toBeTruthy();
      expect(store.getPhoto(photo.id)?.status).toBe('published');
    } finally { store.close(); }
  });

  it('retries failed scores before moving the persistent cursor backward and stops after five attempts', () => {
    const store = new PhotoStore(':memory:');
    try {
      const photos = [0, 1, 2].map(index => store.importPhoto({ filePath: `/queue-${index}.jpg`, fileHash: `queue-${index}`, capturedAt: `2026-01-0${index + 1}T10:00:00.000Z`, latitude: null, longitude: null, locationName: null, title: '照片', description: '' }));
      expect(store.scanCandidates(10).map(photo => photo.id)).toEqual([photos[2].id, photos[1].id, photos[0].id]);
      store.saveAnalysis(photos[2].id, { metrics: null, assessment: null, totalScore: null, status: 'needs_analysis', error: '模型超时', analysisVersion: 'test', outcome: 'failed' });
      store.setScanCursor(photos[2]);
      expect(store.getPhoto(photos[2].id)?.analysisAttempts).toBe(1);
      expect(store.scanCandidates(10)[0].id).toBe(photos[2].id);
      for (let attempt = 0; attempt < 4; attempt++) store.saveAnalysis(photos[2].id, { metrics: null, assessment: null, totalScore: null, status: 'needs_analysis', error: '模型超时', analysisVersion: 'test', outcome: 'failed' });
      expect(store.getPhoto(photos[2].id)?.analysisAttempts).toBe(5);
      expect(store.scanCandidates(10).map(photo => photo.id)).toEqual([photos[1].id, photos[0].id]);
    } finally { store.close(); }
  });
});
