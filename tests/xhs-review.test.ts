import { afterEach, describe, expect, it, vi } from 'vitest';
import { XhsDraftReview, reviewInputSchema } from '../src/xhs-review.js';
import type { XhsPublisher } from '../src/xhs.js';

const target = { title: '壶口不铺 陕西一侧', description: '黄河', photoIds: [1, 2], draftSavedAt: '2026-10-25T03:16:45Z', xhsDraftId: 'original-draft' };
function setup(idleMs?: number) {
  const publisher = { open: vi.fn(), close: vi.fn(), screenshot: vi.fn(async () => undefined), openSavedDraft: vi.fn(async () => ({ draftId: 'original-draft', account: null, storage: 'browser_local' })), reviewFrame: vi.fn(async () => Buffer.from('frame')), reviewInput: vi.fn(), saveDraft: vi.fn() };
  const create = vi.fn(() => publisher as unknown as XhsPublisher);
  return { review: new XhsDraftReview(create, idleMs), publisher, create };
}
afterEach(() => vi.useRealTimers());

describe('human review of an existing XHS browser draft', () => {
  it('reopens the recorded draft without uploading or saving another copy', async () => {
    const { review, publisher } = setup();
    const session = await review.start(5, target);
    expect(session.evidence).toMatchObject({ draftId: 'original-draft', storage: 'browser_local' });
    expect(publisher.openSavedDraft).toHaveBeenCalledWith(target);
    expect(await review.frame(session.token)).toEqual(Buffer.from('frame'));
    expect(publisher.saveDraft).not.toHaveBeenCalled();
    await review.close(session.token);
    expect(publisher.close).toHaveBeenCalledTimes(1);
  });
  it('rejects a second window and unrelated tokens without interrupting the first', async () => {
    const { review, publisher, create } = setup();
    const first = await review.start(5, target);
    await expect(review.start(6, target)).rejects.toThrow('已有');
    await expect(review.frame('wrong')).rejects.toThrow('已关闭或过期');
    await expect(review.close('wrong')).rejects.toThrow('已关闭或过期');
    expect(create).toHaveBeenCalledTimes(1);
    expect(publisher.close).not.toHaveBeenCalled();
    await review.close(first.token);
  });
  it('releases the shared browser after failed revalidation', async () => {
    const { review, publisher } = setup();
    publisher.openSavedDraft.mockRejectedValueOnce(new Error('原草稿不存在'));
    await expect(review.start(5, target)).rejects.toThrow('不存在');
    expect(publisher.close).toHaveBeenCalledTimes(1);
    const session = await review.start(5, target); await review.close(session.token);
  });
  it('expires idle sessions even while the page keeps requesting frames', async () => {
    vi.useFakeTimers(); const { review, publisher } = setup(1000);
    const session = await review.start(5, target);
    await vi.advanceTimersByTimeAsync(800); await review.frame(session.token);
    await vi.advanceTimersByTimeAsync(250);
    expect(publisher.close).toHaveBeenCalledTimes(1);
    await expect(review.frame(session.token)).rejects.toThrow('过期');
  });
  it('only forwards bounded human inputs and renews the lease for actual input', async () => {
    vi.useFakeTimers(); const { review, publisher } = setup(1000);
    const session = await review.start(5, target);
    await vi.advanceTimersByTimeAsync(800);
    await review.input(session.token, { kind: 'scroll', x: 500, y: 300, deltaY: 200 });
    await vi.advanceTimersByTimeAsync(500); expect(publisher.close).not.toHaveBeenCalled();
    await expect(review.input(session.token, { kind: 'key', key: 'Control+L' })).rejects.toThrow();
    await expect(review.input(session.token, { kind: 'click', x: 1440, y: -1 })).rejects.toThrow();
    expect(publisher.reviewInput).toHaveBeenCalledTimes(1);
    expect(reviewInputSchema.safeParse({ kind: 'evaluate', text: 'script' }).success).toBe(false);
    await review.close(session.token);
  });
});
