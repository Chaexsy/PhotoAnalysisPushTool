import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { XhsPublisher } from './xhs.js';
import { config } from './config.js';
import { logger } from './logger.js';
import path from 'node:path';
import type { XhsDraftTarget, XhsDraftEvidence } from './xhs-drafts.js';

const coordinate = z.number().finite().nonnegative();
export const reviewInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), x: coordinate.max(1439), y: coordinate.max(999) }),
  z.object({ kind: z.literal('scroll'), x: coordinate.max(1439), y: coordinate.max(999), deltaY: z.number().finite().min(-1000).max(1000) }),
  z.object({ kind: z.literal('key'), key: z.enum(['Enter', 'Backspace', 'Delete', 'Tab', 'Shift+Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Control+A', 'Control+Z']) }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(2000) })
]);

/** One human-operated view holds the existing browser lease until closed or idle. */
export class XhsDraftReview {
  private session: { token: string; postId: number; publisher: XhsPublisher; evidence: XhsDraftEvidence } | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private createPublisher = () => new XhsPublisher(), private idleMs = 10 * 60000) {}

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn); this.tail = result.catch(() => undefined); return result;
  }
  private touch() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => void this.queue(() => this.closeCurrent()), this.idleMs);
    this.expiry.unref();
  }
  private requireSession(token: string) {
    if (!this.session || !token || this.session.token !== token) throw new Error('小红书草稿操作窗口已关闭或过期，请重新打开');
    return this.session;
  }
  private async closeCurrent() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    const current = this.session; this.session = null;
    await current?.publisher.close();
  }
  start(postId: number, target: XhsDraftTarget) {
    return this.queue(async () => {
      if (this.session) throw new Error('已有小红书草稿操作窗口，请先关闭它再打开其他笔记');
      const publisher = this.createPublisher();
      try {
        await publisher.open();
        const evidence = await publisher.openSavedDraft(target);
        const token = randomUUID();
        this.session = { token, postId, publisher, evidence }; this.touch();
        return { token, postId, width: 1440, height: 1000, evidence };
      } catch (error) {
        logger.warn({ postId, error: String(error) }, 'opening saved XHS draft failed');
        await publisher.screenshot(path.join(config.DATA_ROOT, 'xhs-review-open-failed.png')).catch(() => undefined);
        await publisher.close();
        if (/Timeout|timed out/i.test(String(error))) throw new Error('打开小红书原草稿超时，未重新保存，请稍后重试');
        throw error;
      }
    });
  }
  frame(token: string) { return this.queue(async () => this.requireSession(token).publisher.reviewFrame()); }
  input(token: string, input: unknown) {
    return this.queue(async () => {
      const session = this.requireSession(token);
      const parsed = reviewInputSchema.parse(input);
      this.touch(); await session.publisher.reviewInput(parsed);
    });
  }
  close(token: string) { return this.queue(async () => { this.requireSession(token); await this.closeCurrent(); }); }
}

export const xhsDraftReview = new XhsDraftReview();
