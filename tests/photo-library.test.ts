import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PhotoStore } from '../src/db.js';
import { PhotoLibrary, parseLibraryQuery } from '../src/photo-library.js';

const metrics = { width: 1600, height: 900, orientation: 'landscape' as const, technicalScore: 80, brightness: .5, sharpness: 100, darkFraction: .01, lightFraction: .01, visualHash: 'a', perceptualHash: 'a' };
const assessment = { quality: 80, composition: 78, aesthetics: 82, story: 70, summary: '人物在街头互动', observations: ['主体清晰'], theme: '人物活动' as const, reason: '动作可见' };
const query = (options = {}) => parseLibraryQuery({ limit: 48, ...options });
const importPhoto = (store: PhotoStore, filePath: string, fileHash: string, capturedAt: string | null = null, locationName: string | null = null) => store.importPhoto({ filePath, fileHash, capturedAt, locationName, latitude: null, longitude: null, title: '照片', description: '' });

describe('photo library browsing', () => {
  it('shows duplicate files and untouched files, shares assessments, and invalidates changed files', () => {
    const store = new PhotoStore(':memory:');
    try {
      const photo = importPhoto(store, '/photos/旅行/a.jpg', 'hash');
      store.saveAnalysis(photo.id, { metrics, assessment, totalScore: 78, status: 'rejected', error: '故事性评分不足', analysisVersion: 'test' });
      store.cacheFile('/photos/旅行/a.jpg', 100, 1000, photo.id);
      store.cacheFile('/photos/备份/a.jpg', 100, 1000, photo.id);
      const files = ['/photos/旅行/a.jpg', '/photos/备份/a.jpg', '/photos/新图.jpg'].map(filePath => ({ filePath, size: 100, mtimeMs: 1000 }));
      store.replaceLibraryFiles(files);
      const first = store.searchPhotoLibrary(query());
      expect(first.total).toBe(3);
      expect(first.photos.filter(p => p.assessment)).toHaveLength(2);
      expect(store.searchPhotoLibrary(query({ scan: 'unscanned' })).photos[0].photoId).toBeNull();
      expect(store.searchPhotoLibrary(query({ rated: 'rated', directory: '/photos/备份' })).photos[0].assessment?.reason).toBe(assessment.reason);
      const fileId = first.photos.find(p => p.filePath === '/photos/旅行/a.jpg')!.fileId;
      store.replaceLibraryFiles([ { ...files[0], size: 200 }, files[2] ]);
      const changed = store.searchPhotoLibrary(query()).photos.find(p => p.fileId === fileId)!;
      expect(changed.scanState).toBe('unscanned');
      expect(changed.assessment).toBeNull();
      expect(store.searchPhotoLibrary(query()).total).toBe(2);
      expect(store.getPhoto(photo.id)?.assessment).toEqual(assessment);
    } finally { store.close(); }
  });

  it('separates technical rejection from failures and keeps zero scores searchable', () => {
    const store = new PhotoStore(':memory:');
    try {
      const files = ['technical', 'failed', 'rated', 'waiting'].map((name, i) => {
        const filePath = `/photos/${name}.jpg`, photo = importPhoto(store, filePath, name);
        store.cacheFile(filePath, 10, 1000, photo.id);
        if (name === 'technical') store.saveAnalysis(photo.id, { metrics, assessment: null, totalScore: null, status: 'rejected', error: '像素不足', analysisVersion: 'test', outcome: 'skipped' });
        if (name === 'failed') store.saveAnalysis(photo.id, { metrics, assessment: null, totalScore: null, status: 'needs_analysis', error: '模型 JSON 错误', analysisVersion: 'test', outcome: 'failed' });
        if (name === 'rated') store.saveAnalysis(photo.id, { metrics, assessment: { ...assessment, aesthetics: 0 }, totalScore: 0, status: 'rejected', error: '美学评分不足', analysisVersion: 'test' });
        return { filePath, size: 10, mtimeMs: 1000 };
      });
      store.replaceLibraryFiles(files);
      expect(store.searchPhotoLibrary(query({ scan: 'failed' })).photos.map(p => p.fileName)).toEqual(['failed.jpg']);
      expect(store.searchPhotoLibrary(query({ evaluated: 'skipped' })).photos[0].scanState).toBe('scanned');
      expect(store.searchPhotoLibrary(query({ rated: 'rated' })).photos[0].totalScore).toBe(0);
      expect(store.searchPhotoLibrary(query({ scan: 'scanned' })).total).toBe(3);
      expect(store.searchPhotoLibrary(query({ scan: 'unscanned' })).total).toBe(1);
    } finally { store.close(); }
  });

  it('combines directories, literal keywords, local day boundaries, sorting, and pagination', () => {
    const store = new PhotoStore(':memory:');
    try {
      const dates = [new Date(2026, 9, 14, 0, 0), new Date(2026, 9, 14, 23, 59, 59), new Date(2026, 9, 15, 0, 0)];
      const files = dates.map((date, i) => {
        const filePath = `/photos/旅行_1/子目录/${i}.jpg`;
        const photo = importPhoto(store, filePath, String(i), date.toISOString(), '杭州_% · 湖边');
        store.cacheFile(filePath, 10, date.getTime(), photo.id);
        store.saveAnalysis(photo.id, { metrics, assessment, totalScore: i * 20, status: 'pending', error: null, analysisVersion: 'test' });
        return { filePath, size: 10, mtimeMs: date.getTime() };
      });
      const sibling = importPhoto(store, '/photos/旅行X1/other.jpg', 'sibling', dates[0].toISOString(), '杭州其他');
      store.cacheFile(sibling.filePath, 10, 1000, sibling.id);
      store.replaceLibraryFiles([...files, { filePath: sibling.filePath, size: 10, mtimeMs: 1000 }]);
      const filter = { directory: '/photos/旅行_1', location: '_%', from: '2026-10-14', to: '2026-10-14' };
      expect(store.searchPhotoLibrary(query(filter)).total).toBe(2);
      expect(store.searchPhotoLibrary(query({ ...filter, sort: 'score', limit: 1, offset: 1 })).photos[0].totalScore).toBe(0);
      expect(store.searchPhotoLibrary(query({ ...filter, timeField: 'modified' })).total).toBe(2);
      expect(store.searchPhotoLibrary(query({ hasLocation: 'yes' })).total).toBe(4);
      expect(store.searchPhotoLibrary(query({ hasLocation: 'no' })).total).toBe(0);
      expect(() => query({ from: '2026-02-30' })).toThrow('日期不存在');
      expect(() => query({ from: '2026-10-15', to: '2026-10-14' })).toThrow('起始日期');
      expect(() => query({ limit: -1 })).toThrow();
    } finally { store.close(); }
  });

  it('indexes new images without analysis, serves resized previews, and blocks files outside the root', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-library-'));
    const root = path.join(dir, 'photos'), store = new PhotoStore(':memory:');
    try {
      await fs.mkdir(root);
      const filePath = path.join(root, 'fresh.jpg');
      await sharp({ create: { width: 800, height: 600, channels: 3, background: '#008855' } }).jpeg().toFile(filePath);
      await fs.writeFile(path.join(root, 'notes.txt'), 'not an image');
      const library = new PhotoLibrary(store, root);
      const results = await library.search(query());
      expect(results.total).toBe(1);
      expect(results.photos[0].scanState).toBe('unscanned');
      expect(store.listPhotos()).toHaveLength(0);
      const preview = await library.thumbnail(results.photos[0].fileId, 480);
      expect((await sharp(preview).metadata()).width).toBe(480);
      const outside = path.join(dir, 'outside.jpg'); await fs.writeFile(outside, 'outside');
      store.replaceLibraryFiles([{ filePath: outside, size: 7, mtimeMs: 1000 }]);
      const outsideItem = store.searchPhotoLibrary(query()).photos[0];
      await expect(library.resolveFile(outsideItem.fileId)).rejects.toThrow('不在指定目录');
    } finally { store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });
});
