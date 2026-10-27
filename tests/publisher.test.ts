import { beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), verifyMetadata: vi.fn(), saveDraft: vi.fn(), wasSubmissionStarted: vi.fn() }));
vi.mock('../src/xhs.js', () => ({ XhsPublisher: class { open = browser.open; close = browser.close; verifyMetadata = browser.verifyMetadata; saveDraft = browser.saveDraft; wasSubmissionStarted = browser.wasSubmissionStarted; } }));
vi.mock('../src/repository.js', async () => {
  const { PhotoStore } = await import('../src/db.js');
  return { store: new PhotoStore(':memory:'), selectionPolicy: { minQuality: 60, minAesthetics: 65, minStory: 60, minComposition: 60, minTotal: 60, minTechnical: 50, minShortEdge: 500, maxImages: 6, duplicateDistance: 4 } };
});
import { store, selectionPolicy } from '../src/repository.js';
import { publishDraft } from '../src/publisher.js';

beforeEach(() => {
  vi.resetAllMocks();
  store.db.exec('DELETE FROM post_photos; DELETE FROM posts; DELETE FROM photos; DELETE FROM events;');
  browser.open.mockResolvedValue(undefined); browser.close.mockResolvedValue(undefined); browser.verifyMetadata.mockResolvedValue(undefined);
  browser.wasSubmissionStarted.mockReturnValue(false);
  browser.saveDraft.mockResolvedValue({ saved: true, confirmed: true, submitted: true, remoteUrl: null, evidence: { draftId: 'actual-xhs-id', account: '测试账号', storage: 'browser_local' } });
});
function fixture() {
  const photo = store.importPhoto({ filePath: '/photo.jpg', fileHash: 'photo', capturedAt: '2026-10-01T10:00:00Z', latitude: null, longitude: null, locationName: null, title: '', description: '' });
  store.saveAnalysis(photo.id, { metrics: { width: 1600, height: 900, orientation: 'landscape', technicalScore: 90, brightness: .5, sharpness: 100, darkFraction: 0, lightFraction: 0, visualHash: 'visual', perceptualHash: 'hash' }, assessment: { quality: 90, aesthetics: 90, composition: 90, story: 70, summary: '黄河', observations: [], theme: '自然风景', reason: '适合' }, totalScore: 85, status: 'pending', error: null, analysisVersion: 'test' });
  store.groupPhotos(6, 300); store.ensureDrafts(selectionPolicy);
  return { draft: store.listDrafts()[0], photo };
}

describe('saving an XHS draft', () => {
  it('moves a confirmed save out of the queue with a save timestamp and preserves unpublished status', async () => {
    const { draft, photo } = fixture();
    await publishDraft(draft.id);
    expect(store.listDrafts()).toHaveLength(0);
    expect(store.listPosts()[0]).toMatchObject({ status: 'draft_saved', publishedAt: null, error: null, xhsDraftId: 'actual-xhs-id', xhsDraftAccount: '测试账号', xhsDraftStorage: 'browser_local' });
    expect(store.listPosts()[0].draftSavedAt).toBeTruthy();
    expect(store.getPhoto(photo.id)?.status).toBe('draft_saved');
  });

  it('keeps a failed pre-save in the queue with its reason and editable photos', async () => {
    const { draft, photo } = fixture();
    browser.saveDraft.mockRejectedValueOnce(new Error('地点入口不存在'));
    await expect(publishDraft(draft.id)).rejects.toThrow('地点入口不存在');
    expect(store.listDrafts()[0]).toMatchObject({ id: draft.id, error: '地点入口不存在', draftSavedAt: null });
    expect(store.getPhoto(photo.id)?.status).toBe('pending');
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('records metadata failures without reserving photos', async () => {
    const { draft, photo } = fixture();
    browser.verifyMetadata.mockRejectedValueOnce(new Error('地点候选变化'));
    await expect(publishDraft(draft.id)).rejects.toThrow('地点候选变化');
    expect(store.listDrafts()[0].error).toBe('地点候选变化');
    expect(store.getPhoto(photo.id)?.status).toBe('pending');
    expect(browser.saveDraft).not.toHaveBeenCalled();
  });

  it('shares one in-flight request and prevents a second save of the same note', async () => {
    const { draft } = fixture();
    let finish!: (result: any) => void;
    browser.saveDraft.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = publishDraft(draft.id), second = publishDraft(draft.id);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(browser.saveDraft).toHaveBeenCalledTimes(1));
    finish({ saved: true, confirmed: true, remoteUrl: null });
    await Promise.all([first, second]);
    await expect(publishDraft(draft.id)).rejects.toThrow('草稿不存在');
    expect(browser.saveDraft).toHaveBeenCalledTimes(1);
  });

  it('retains an unconfirmed submission for manual verification instead of retrying it', async () => {
    const { draft } = fixture();
    browser.wasSubmissionStarted.mockReturnValue(true);
    browser.saveDraft.mockRejectedValueOnce(new Error('已点击暂存，未确认保存结果'));
    await expect(publishDraft(draft.id)).rejects.toThrow('未确认');
    expect(store.listPosts()[0].status).toBe('uncertain');
    await expect(publishDraft(draft.id)).rejects.toThrow('草稿不存在');
    expect(browser.saveDraft).toHaveBeenCalledTimes(1);
  });
});
