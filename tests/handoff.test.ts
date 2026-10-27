import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { PhotoStore } from '../src/db.js';
import { handoffDetails, handoffPackage, handoffConfirmationSchema } from '../src/handoff.js';
import type { SelectionPolicy } from '../src/selection.js';

const policy: SelectionPolicy = { minQuality: 60, minAesthetics: 65, minStory: 60, minComposition: 60, minTotal: 60, minTechnical: 50, minShortEdge: 500, maxImages: 6, duplicateDistance: 4 };
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture(count = 2, maxImages = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-handoff-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PhotoStore(':memory:'); cleanup.push(() => store.close());
  const activePolicy = { ...policy, maxImages };
  const photos = Array.from({ length: count }, (_, i) => {
    const filePath = path.join(dir, String(i), '黄河照片.jpg');
    fs.mkdirSync(path.dirname(filePath)); fs.writeFileSync(filePath, Buffer.from([255, 216, i, 255, 217]));
    const photo = store.importPhoto({ filePath, fileHash: `hash-${i}`, capturedAt: '2026-10-01T10:00:00Z', latitude: null, longitude: null, locationName: null, title: '', description: '' });
    store.saveAnalysis(photo.id, { metrics: { width: 1600, height: 900, orientation: 'landscape', technicalScore: 90, brightness: .5, sharpness: 100, darkFraction: 0, lightFraction: 0, visualHash: `visual-${i}`, perceptualHash: `test-hash-${i}` }, assessment: { quality: 90, aesthetics: 90, composition: 90, story: 70, summary: '黄河风景', observations: [], theme: '自然风景', reason: '适合' }, totalScore: 85, status: 'pending', error: null, analysisVersion: 'test' });
    return store.getPhoto(photo.id)!;
  });
  store.groupPhotos(6, 300); store.ensureDrafts(activePolicy);
  return { store, photos, draft: store.listDrafts()[0], policy: activePolicy };
}

// Read central-directory lengths, rather than scanning compressed content for signatures.
function unzip(buffer: Buffer) {
  const end = buffer.length - 22;
  expect(buffer.readUInt32LE(end)).toBe(0x06054b50);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const size = buffer.readUInt32LE(offset + 20), nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = buffer.readUInt32LE(offset + 42);
    expect(buffer.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    const data = buffer.readUInt16LE(offset + 10) === 0 ? raw : inflateRawSync(raw);
    expect(data.length).toBe(buffer.readUInt32LE(offset + 24));
    entries.set(name, data);
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return entries;
}

describe('manual material handoff', () => {
  it('exports numbered original bytes in selected order and copy, without changing state or quota', async () => {
    const { store, photos, draft } = fixture();
    const edited = store.updateDraft(draft.id, [photos[1].id, photos[0].id], policy, { title: '', description: '黄河奔流', topics: ['壶口瀑布'], locationTag: '壶口瀑布景区' });
    const before = { posts: store.listPosts(), photos: store.listPhotos(), events: store.listEvents() };
    const details = handoffDetails(store, edited.id);
    expect(details.photos.map(p => p.id)).toEqual([photos[1].id, photos[0].id]);
    expect(JSON.stringify(details)).not.toContain(photos[0].filePath);
    const { zip } = await handoffPackage(store, edited.id, edited.revision);
    const bytes: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => { zip.on('error', reject); zip.outputStream.on('data', chunk => bytes.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(bytes))); });
    zip.end();
    const entries = unzip(await done);
    expect([...entries.keys()].slice(0, 2)).toEqual(['01-黄河照片.jpg', '02-黄河照片.jpg']);
    expect(entries.get('01-黄河照片.jpg')).toEqual(fs.readFileSync(photos[1].filePath));
    expect(entries.get('02-黄河照片.jpg')).toEqual(fs.readFileSync(photos[0].filePath));
    expect(entries.get('文案.txt')?.toString()).toBe('黄河奔流');
    expect(entries.get('标题.txt')?.toString()).toBe('');
    expect(entries.get('话题.txt')?.toString()).toBe('#壶口瀑布');
    expect(entries.get('发布说明.txt')?.toString()).toContain('不会变更系统笔记状态');
    expect({ posts: store.listPosts(), photos: store.listPhotos(), events: store.listEvents() }).toEqual(before);
  });

  it('rejects a missing original or stale revision before returning a ZIP', async () => {
    const { store, photos, draft } = fixture();
    await expect(handoffPackage(store, draft.id, draft.revision + 1)).rejects.toThrow('变化');
    fs.unlinkSync(photos[1].filePath);
    await expect(handoffPackage(store, draft.id, draft.revision)).rejects.toThrow('原图不可读取');
    expect(store.listDrafts()).toHaveLength(1);
  });

  it('records explicit manual saving atomically, is idempotent, and can later confirm publication', () => {
    const { store, draft, photos } = fixture();
    const saved = store.confirmHandoff(draft.id, draft.revision, 'draft_saved', policy);
    expect(saved).toMatchObject({ status: 'draft_saved', xhsDraftStorage: 'user_browser_local', publishedAt: null });
    expect(saved.manualConfirmedAt).toBeTruthy(); expect(saved.draftSavedAt).toBeTruthy();
    expect(store.getPhoto(photos[0].id)).toMatchObject({ status: 'draft_saved', publishedAt: null });
    expect(store.listDrafts()).toHaveLength(0);
    expect(store.confirmHandoff(draft.id, draft.revision, 'draft_saved', policy)).toEqual(saved);
    expect(store.listEvents()[0].usedPosts).toBe(1);
    const published = store.confirmHandoff(saved.id, saved.revision, 'published', policy);
    expect(published).toMatchObject({ status: 'published', draftSavedAt: saved.draftSavedAt });
    expect(published.publishedAt).toBeTruthy(); expect(store.listEvents()[0].usedPosts).toBe(1);
    expect(store.getPhoto(photos[0].id)?.publishedAt).toBe(published.publishedAt);
    expect(() => store.confirmHandoff(published.id, published.revision, 'draft_saved', policy)).toThrow();
  });

  it('can publish an already saved draft when all three event slots are consumed', () => {
    const { store, policy: one } = fixture(3, 1);
    const saved = store.listDrafts().map(draft => store.confirmHandoff(draft.id, draft.revision, 'draft_saved', one));
    expect(store.listEvents()[0].usedPosts).toBe(3);
    store.confirmHandoff(saved[2].id, saved[2].revision, 'published', one);
    expect(store.listEvents()[0].usedPosts).toBe(3);
  });

  it('does not record a result for edited or ineligible material', () => {
    const { store, draft, photos } = fixture();
    store.updateDraft(draft.id, draft.photoIds, policy, { title: '已修改' });
    expect(() => store.confirmHandoff(draft.id, draft.revision, 'published', policy)).toThrow('变化');
    const latest = store.listDrafts()[0];
    store.db.prepare("UPDATE photos SET status='published' WHERE id=?").run(photos[0].id);
    expect(() => store.confirmHandoff(latest.id, latest.revision, 'published', policy)).toThrow('不能重复发布');
    expect(store.listDrafts()[0].manualConfirmedAt).toBeNull();
    expect(store.listEvents()[0].usedPosts).toBe(0);
  });

  it('preserves historic NAS-local records for export and distinguishes their source', () => {
    const { store, draft } = fixture();
    store.reserveDraft(draft.id, policy); store.finishPost(draft.id, 'draft_saved', null, null);
    expect(store.listPosts()[0]).toMatchObject({ xhsDraftStorage: 'browser_local', manualConfirmedAt: null });
    expect(handoffDetails(store, draft.id).status).toBe('draft_saved');
    const old = store.listPosts()[0];
    const manual = store.confirmHandoff(old.id, old.revision, 'draft_saved', policy);
    expect(manual.xhsDraftStorage).toBe('user_browser_local');
    expect(manual.manualConfirmedAt).toBeTruthy();
    expect(store.listEvents()[0].usedPosts).toBe(1);
  });

  it('requires an explicit confirmation and rejects malformed requests', () => {
    expect(handoffConfirmationSchema.safeParse({ revision: 0, result: 'published' }).success).toBe(false);
    expect(handoffConfirmationSchema.safeParse({ revision: 0, result: 'draft_saved', confirmed: false }).success).toBe(false);
    expect(handoffConfirmationSchema.safeParse({ revision: -1, result: 'published', confirmed: true }).success).toBe(false);
    expect(handoffConfirmationSchema.safeParse({ revision: 0, result: 'published', confirmed: true }).success).toBe(true);
  });
});
