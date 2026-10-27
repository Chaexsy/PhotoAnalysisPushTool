import { config, getPublicSettings } from './config.js';
import { logger } from './logger.js';
import { store, selectionPolicy } from './repository.js';
import { serialized } from './operations.js';
import { XhsPublisher } from './xhs.js';
import { draftSaveErrorMessage } from './xhs-drafts.js';

const activeDraftSaves = new Map<number, Promise<{ remoteUrl: string | null; confirmed: boolean; saved: boolean }>>();

export async function publishPending(limit = config.MAX_POSTS_PER_RUN): Promise<{ attempted: number; published: number; saved: number; failed: number; uncertain: number }> {
  if (!config.PUBLISH_ENABLED) { logger.info('automatic XHS draft saving disabled; scan-and-review mode'); return { attempted: 0, published: 0, saved: 0, failed: 0, uncertain: 0 }; }
  return serialized(async () => {
    const drafts = store.listDrafts().filter(draft => draft.scheduledAt && Date.parse(draft.scheduledAt) <= Date.now()).slice(0, limit);
    let attempted = 0, published = 0, saved = 0, failed = 0, uncertain = 0;
    const publisher = new XhsPublisher();
    if (!drafts.length) return { attempted, published, saved, failed, uncertain };
    await publisher.open();
    try {
      for (const draft of drafts) {
        attempted++;
        let reservedPostId: number | null = null;
        try {
          // Validate saved topic/location display text while the post is still
          // a draft. A failed candidate lookup therefore cannot create a
          // publishing record or consume the draft's photos.
          const preview = store.previewDraft(draft.id, selectionPolicy);
          await publisher.verifyMetadata(preview);
          store.markDraftMetadataVerified(draft.id, preview.topics ?? [], Boolean(preview.locationName));
          const reserved = store.reserveDraft(draft.id, selectionPolicy);
          reservedPostId = reserved.postId;
          const result = await publisher.saveDraft(reserved.batch);
          if (result.evidence) store.recordXhsDraftEvidence(reserved.postId, result.evidence);
          store.markSubmitted(reserved.postId);
          if (!result.saved) {
            store.finishPost(reserved.postId, 'uncertain', null, '小红书未确认草稿已保存，请人工核验后再处理'); uncertain++;
          } else { store.finishPost(reserved.postId, 'draft_saved', null, null); saved++; }
        } catch (error) {
          failed++;
          const message = draftSaveErrorMessage(error);
          if (reservedPostId !== null) {
            if (publisher.wasSubmissionStarted()) {
              store.finishPost(reservedPostId, 'uncertain', null, error instanceof Error ? error.message : String(error));
              uncertain++;
            } else store.releasePostToDraft(reservedPostId, message);
          } else store.recordDraftSaveError(draft.id, message);
          logger.error({ error, eventId: draft.eventId }, 'photo batch publish failed');
        }
      }
    } finally { await publisher.close(); }
    return { attempted, published, saved, failed, uncertain };
  });
}

export async function publishSelected(photoIds: number[]): Promise<void> {
  if (!config.PUBLISH_ENABLED) throw new Error('PUBLISH_ENABLED=false，当前是扫描和审核模式');
  return serialized(async () => {
    const reserved = store.reserve(photoIds, selectionPolicy);
    const publisher = new XhsPublisher();
    await publisher.open();
    try {
      const result = await publisher.saveDraft(reserved.batch);
      if (result.evidence) store.recordXhsDraftEvidence(reserved.postId, result.evidence);
      store.markSubmitted(reserved.postId);
      store.finishPost(reserved.postId, result.saved ? 'draft_saved' : 'uncertain', null,
        result.saved ? null : '小红书未确认草稿已保存，请人工核验后再处理');
      if (!result.saved) throw new Error(`笔记 ${reserved.postId} 的草稿保存结果不确定，请人工核验，禁止自动重试`);
    } catch (error) {
      if (publisher.wasSubmissionStarted() && store.listPosts().some(p => p.id === reserved.postId && p.status === 'publishing')) {
        store.finishPost(reserved.postId, 'uncertain', null, error instanceof Error ? error.message : String(error));
      } else if (!publisher.wasSubmissionStarted()) store.releasePostToDraft(reserved.postId);
      throw error;
    } finally { await publisher.close(); }
  });
}

/** Save one draft to the XHS creator explicitly requested by the user.
 *
 * This path intentionally ignores the automatic draft-saving switch. The
 * explicit button remains available in review mode. The draft is moved to
 * `publishing` before opening XHS so an interrupted browser session is
 * recoverable as an uncertain result.
 */
export function publishDraft(postId: number): Promise<{ remoteUrl: string | null; confirmed: boolean; saved: boolean }> {
  const active = activeDraftSaves.get(postId);
  if (active) return active;
  const operation = serialized(async () => {
    const preview = store.previewDraft(postId, selectionPolicy);
    const publisher = new XhsPublisher();
    try {
      await publisher.open();
      await publisher.verifyMetadata(preview);
      store.markDraftMetadataVerified(postId, preview.topics ?? [], Boolean(preview.locationName));
      const reserved = store.reserveDraft(postId, selectionPolicy);
      const result = await publisher.saveDraft(reserved.batch);
      if (result.evidence) store.recordXhsDraftEvidence(reserved.postId, result.evidence);
      store.markSubmitted(reserved.postId);
      store.finishPost(
        reserved.postId,
        result.saved ? 'draft_saved' : 'uncertain',
        null,
        result.saved ? null : '小红书未确认草稿已保存，请人工核验后再处理'
      );
      if (!result.saved) throw new Error(`笔记 ${reserved.postId} 的草稿保存结果不确定，请人工核验，禁止自动重试`);
      return result;
    } catch (error) {
      const current = store.listPosts().find(post => post.id === postId);
      if (publisher.wasSubmissionStarted() && current && (current.status === 'publishing' || current.status === 'submitted')) {
        store.finishPost(postId, 'uncertain', null, error instanceof Error ? error.message : String(error));
      } else if (current?.status === 'publishing') store.releasePostToDraft(postId, draftSaveErrorMessage(error));
      else if (current?.status === 'draft') store.recordDraftSaveError(postId, draftSaveErrorMessage(error));
      throw error;
    } finally {
      await publisher.close();
    }
  }).finally(() => { activeDraftSaves.delete(postId); });
  activeDraftSaves.set(postId, operation);
  return operation;
}

export function status() {
  return { config: { publishEnabled: config.PUBLISH_ENABLED, publishMode: 'manual_handoff', schedule: config.SCHEDULE, photoRoot: config.PHOTO_ROOT,
      eventGapHours: config.EVENT_GAP_HOURS, eventRadiusMeters: config.EVENT_RADIUS_METERS, maxPostsPerEvent: 3,
      settings: getPublicSettings() },
    counts: store.counts(), posts: store.listPosts().slice(0, 20) };
}
