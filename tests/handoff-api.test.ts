import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/repository.js', async () => {
  const { PhotoStore } = await import('../src/db.js');
  return { store: new PhotoStore(':memory:'), selectionPolicy: { minQuality: 60, minAesthetics: 65, minStory: 60, minComposition: 60, minTotal: 60, minTechnical: 50, minShortEdge: 500, maxImages: 6, duplicateDistance: 4 } };
});
vi.mock('../src/scheduler.js', () => ({ reschedule: vi.fn() }));
vi.mock('../src/xhs.js', () => ({ XhsPublisher: vi.fn() }));
import { createServer } from '../src/server.js';
import { store, selectionPolicy } from '../src/repository.js';
import { XhsPublisher } from '../src/xhs.js';

let server: Server, root: string, dir: string, draftId: number;
beforeEach(async () => {
  vi.clearAllMocks();
  store.db.exec('DELETE FROM post_photos; DELETE FROM posts; DELETE FROM photos; DELETE FROM events;');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-api-'));
  const filePath = path.join(dir, 'photo.jpg'); fs.writeFileSync(filePath, Buffer.from([255, 216, 255, 217]));
  const photo = store.importPhoto({ filePath, fileHash: 'photo', capturedAt: '2026-10-01T10:00:00Z', latitude: null, longitude: null, locationName: null, title: '', description: '' });
  store.saveAnalysis(photo.id, { metrics: { width: 1600, height: 900, orientation: 'landscape', technicalScore: 90, brightness: .5, sharpness: 100, darkFraction: 0, lightFraction: 0, visualHash: 'visual', perceptualHash: 'hash' }, assessment: { quality: 90, aesthetics: 90, composition: 90, story: 70, summary: '黄河', observations: [], theme: '自然风景', reason: '适合' }, totalScore: 85, status: 'pending', error: null, analysisVersion: 'test' });
  store.groupPhotos(6, 300); store.ensureDrafts(selectionPolicy); draftId = store.listDrafts()[0].id;
  server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); fs.rmSync(dir, { recursive: true, force: true }); });

describe('handoff HTTP boundary', () => {
  it('blocks all former automated submission routes without opening a browser or changing records', async () => {
    const before = store.listPosts();
    for (const route of [`/api/drafts/${draftId}/save`, `/api/drafts/${draftId}/publish`, '/api/publish']) {
      const response = await fetch(root + route, { method: 'POST' });
      expect(response.status).toBe(410);
      expect((await response.json()).error).toContain('人工交接');
    }
    expect(XhsPublisher).not.toHaveBeenCalled(); expect(store.listPosts()).toEqual(before);
  });

  it('downloads a real ZIP without confirming and requires an explicit result before recording', async () => {
    const details = await (await fetch(`${root}/api/drafts/${draftId}/handoff`)).json();
    const response = await fetch(`${root}/api/drafts/${draftId}/package?revision=${details.revision}`);
    expect(response.headers.get('content-type')).toContain('application/zip');
    expect(Buffer.from(await response.arrayBuffer()).readUInt32LE(0)).toBe(0x04034b50);
    expect(store.listDrafts()).toHaveLength(1);
    const confirm = (body: unknown) => fetch(`${root}/api/drafts/${draftId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await confirm({ revision: details.revision, result: 'published' })).status).toBe(400);
    expect(store.listDrafts()).toHaveLength(1);
    const result = await confirm({ revision: details.revision, result: 'draft_saved', confirmed: true });
    expect(result.status).toBe(200); expect((await result.json()).post.manualConfirmedAt).toBeTruthy();
    expect((await (await fetch(root + '/api/drafts')).json()).drafts).toHaveLength(0);
    expect((await (await fetch(root + '/api/publications')).json())[0].status).toBe('draft_saved');
    expect(XhsPublisher).not.toHaveBeenCalled();
  });

  it('cannot re-enable automatic browser submission through runtime settings', async () => {
    const settings = await (await fetch(root + '/api/settings')).json();
    expect(settings).toMatchObject({ publishEnabled: false, publishMode: 'manual_handoff' });
    const response = await fetch(root + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publishEnabled: true }) });
    expect(response.status).toBe(400); expect(XhsPublisher).not.toHaveBeenCalled();
  });
});
