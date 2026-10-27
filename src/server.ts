import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { config, getPublicSettings, updateRuntimeSettings, type RuntimeSettingsPatch } from './config.js';
import { status } from './publisher.js';
import { handoffDetails, handoffPackage, handoffConfirmationSchema } from './handoff.js';
import { getScanStatus, startScan, stopScan, moveScanCursor } from './scanner.js';
import { getSelectionStatus, startSelection } from './selector.js';
import { logger } from './logger.js';
import { store, selectionPolicy } from './repository.js';
import { reschedule } from './scheduler.js';
import { scheduleDrafts } from './drafts.js';
import { xhsLogin, xhsErrorMessage } from './xhs-login.js';
import { XhsPublisher } from './xhs.js';
import { serialized } from './operations.js';
import { normalizeTopics } from './xhs-metadata.js';
import type { XhsLookupKind } from './xhs-metadata.js';
import { PhotoLibrary, parseLibraryQuery } from './photo-library.js';
import sharp from 'sharp';
import { z } from 'zod';
import { draftSaveErrorMessage } from './xhs-drafts.js';
import { xhsDraftReview } from './xhs-review.js';

const mergeDraftsSchema = z.object({
  sources: z.array(z.object({ id: z.number().int().positive().safe(), revision: z.number().int().nonnegative().safe() })).min(2).max(100),
  photoIds: z.array(z.number().int().positive().safe()).min(1).max(9),
  title: z.string().optional(), description: z.string().optional(), scheduledAt: z.string().nullable().optional()
});

export function createServer() {
  const app = express();
  const library = new PhotoLibrary(store, config.PHOTO_ROOT);
  app.use(cors()); app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.get('/api/settings', (_req, res) => res.json(getPublicSettings()));
  app.put('/api/settings', (req, res) => {
    try {
      const body = req.body ?? {};
      const patch: RuntimeSettingsPatch = {
        publishEnabled: typeof body.publishEnabled === 'boolean' ? body.publishEnabled : undefined,
        visionApiUrl: typeof body.visionApiUrl === 'string' ? body.visionApiUrl : undefined,
        visionApiKey: typeof body.visionApiKey === 'string' ? body.visionApiKey : undefined,
        visionModel: typeof body.visionModel === 'string' ? body.visionModel : undefined,
        xhsAccount: typeof body.xhsAccount === 'string' ? body.xhsAccount : undefined,
        xhsCreatorUrl: typeof body.xhsCreatorUrl === 'string' ? body.xhsCreatorUrl : undefined,
        scheduleCycle: typeof body.scheduleCycle === 'string' ? body.scheduleCycle as RuntimeSettingsPatch['scheduleCycle'] : undefined,
        publishTime: typeof body.publishTime === 'string' ? body.publishTime : undefined,
        weeklyDay: body.weeklyDay === undefined ? undefined : Number(body.weeklyDay)
      };
      const previous = getPublicSettings();
      const settings = updateRuntimeSettings(patch);
      const scheduleChanged = previous.scheduleCycle !== settings.scheduleCycle || previous.publishTime !== settings.publishTime || previous.weeklyDay !== settings.weeklyDay;
      scheduleDrafts(scheduleChanged);
      reschedule();
      return res.json({ ok: true, settings });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get('/api/status', (_req, res) => res.json(status()));
  app.get('/api/photos', (req, res) => {
    if (typeof req.query.ids === 'string') {
      const ids = [...new Set(req.query.ids.split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 500);
      return res.json(ids.map(id => store.getPhoto(id)).filter(Boolean));
    }
    if (typeof req.query.eventId === 'string' && Number.isSafeInteger(Number(req.query.eventId))) {
      const eventId = Number(req.query.eventId);
      if (req.query.summary === '1') return res.json(store.eventPhotoSummaries(eventId));
      return res.json(store.eventPhotos(eventId));
    }
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit ?? 100) || 100));
    return res.json(store.listPhotos(Math.floor(limit)));
  });
  app.get('/api/photo-library', async (req, res) => {
    let query;
    try { query = parseLibraryQuery(req.query); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : '筛选条件无效' }); }
    try { return res.set('Cache-Control', 'no-store').json(await library.search(query)); }
    catch (error) { logger.warn({ error: String(error) }, 'photo library unavailable'); return res.status(503).json({ error: '读取照片目录失败，请检查 NAS 挂载后刷新' }); }
  });
  app.post('/api/photo-library/refresh', async (_req, res) => {
    try { await library.ensureIndex(true); return res.json({ ok: true }); }
    catch { return res.status(503).json({ error: '读取照片目录失败，请检查 NAS 挂载后刷新' }); }
  });
  app.get('/api/photo-library/:id/thumbnail', async (req, res) => {
    try {
      const width = req.query.large === '1' ? 1280 : 480;
      const buffer = await library.thumbnail(Number(req.params.id), width);
      return res.set('Cache-Control', 'private, max-age=60').type('jpeg').send(buffer);
    } catch { return res.status(404).json({ error: '预览不可用，文件可能已移除或图像格式不受支持' }); }
  });
  app.get('/api/photo-library/:id/file', async (req, res) => {
    try {
      const filePath = await library.resolveFile(Number(req.params.id));
      return res.sendFile(filePath, (error) => { if (error && !res.headersSent) res.status(404).json({ error: '照片文件不可用' }); });
    } catch { return res.status(404).json({ error: '照片文件不可用，请刷新照片库' }); }
  });
  app.get('/api/photo-library/:id', async (req, res) => {
    try {
      const photo = await library.detail(Number(req.params.id));
      return photo ? res.set('Cache-Control', 'no-store').json(photo) : res.status(404).json({ error: '照片不存在，请更新图片列表' });
    } catch { return res.status(503).json({ error: '读取照片详情失败' }); }
  });
  app.get('/api/photos/:id/file', (req, res) => {
    const photo = store.getPhoto(Number(req.params.id));
    if (!photo) return res.status(404).json({ error: 'photo not found' });
    return res.sendFile(photo.filePath, { dotfiles: 'deny' }, (error) => { if (error && !res.headersSent) res.status((error as Error & { statusCode?: number }).statusCode ?? 404).json({ error: 'photo file not available' }); });
  });
  app.get('/api/photos/:id', (req, res) => {
    const photo = store.getPhoto(Number(req.params.id));
    return photo ? res.set('Cache-Control', 'no-store').json(photo) : res.status(404).json({ error: '照片不存在' });
  });
  app.put('/api/photos/:id/scores', (req, res) => {
    try {
      const photo = store.updateManualScores(Number(req.params.id), req.body?.scores, req.body?.revision, selectionPolicy);
      return res.json({ ok: true, photo });
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      logger.error({ error: String(error) }, 'manual photo scores failed');
      return res.status(500).json({ error: '保存评分失败，请稍后重试' });
    }
  });
  app.get('/api/photos/:id/thumbnail', async (req, res) => {
    try {
      const photo = store.getPhoto(Number(req.params.id));
      if (!photo) return res.status(404).json({ error: 'photo not found' });
      const width = Math.min(640, Math.max(120, Number(req.query.width ?? 320) || 320));
      const buffer = await sharp(photo.filePath, { failOn: 'error', limitInputPixels: 100000000 }).rotate()
        .resize(width, width, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
      return res.set('Cache-Control', 'private, max-age=300').type('jpeg').send(buffer);
    } catch { return res.status(404).json({ error: 'photo thumbnail not available' }); }
  });
  app.get('/api/events', (_req, res) => res.json(store.listEvents()));
  app.get('/api/posts', (_req, res) => res.json(store.listPosts()));
  app.get('/api/publications', (_req, res) => res.json(store.listPosts().filter(post => !['draft', 'publishing', 'submitted'].includes(post.status))));
  app.use('/api/xhs/review', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: '请从照片发布台打开草稿操作窗口' });
    res.set('Cache-Control', 'no-store'); next();
  });
  app.post('/api/xhs/review/start', async (req, res) => {
    const postId = Number(req.body?.postId);
    const post = store.listPosts().find(item => item.id === postId);
    if (!post || post.status !== 'draft_saved') return res.status(400).json({ error: '请选择已暂存到 NAS 浏览器的小红书草稿' });
    try {
      const result = await serialized(() => xhsDraftReview.start(postId, post));
      store.recordXhsDraftEvidence(postId, result.evidence);
      return res.json(result);
    } catch (error) { return res.status(409).json({ error: draftSaveErrorMessage(error) }); }
  });
  app.get('/api/xhs/review/frame', async (req, res) => {
    try { return res.type('jpeg').send(await xhsDraftReview.frame(req.get('X-Xhs-Review') ?? '')); }
    catch (error) { return res.status(409).json({ error: draftSaveErrorMessage(error) }); }
  });
  app.post('/api/xhs/review/input', async (req, res) => {
    try { await xhsDraftReview.input(req.get('X-Xhs-Review') ?? '', req.body); return res.json({ ok: true }); }
    catch (error) { return res.status(400).json({ error: draftSaveErrorMessage(error) }); }
  });
  app.post('/api/xhs/review/close', async (req, res) => {
    try { await xhsDraftReview.close(req.get('X-Xhs-Review') ?? ''); return res.json({ ok: true }); }
    catch (error) { return res.status(409).json({ error: draftSaveErrorMessage(error) }); }
  });
  app.get('/api/drafts', (_req, res) => res.json({ drafts: store.listPosts().filter(post => ['draft', 'publishing', 'submitted'].includes(post.status)).sort((a, b) => a.id - b.id), schedule: getPublicSettings() }));
  app.get('/api/drafts/:id/handoff', (req, res) => {
    try { return res.set('Cache-Control', 'no-store').json(handoffDetails(store, Number(req.params.id))); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get('/api/drafts/:id/package', async (req, res) => {
    const revision = Number(req.query.revision);
    if (typeof req.query.revision !== 'string' || !Number.isSafeInteger(revision) || revision < 0) return res.status(400).json({ error: '请先打开准备发布窗口' });
    try {
      const { zip } = await handoffPackage(store, Number(req.params.id), revision);
      res.set('Cache-Control', 'no-store').type('application/zip').attachment(`xiaohongshu-${req.params.id}.zip`);
      zip.on('error', error => { logger.error({ error: String(error) }, 'handoff package failed'); res.destroy(); });
      zip.outputStream.on('error', () => res.destroy());
      zip.outputStream.pipe(res);
      res.on('close', () => { if (!res.writableFinished) (zip.outputStream as import('node:stream').Readable).destroy(); });
      zip.end();
      return;
    } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/api/drafts/:id/confirm', (req, res) => {
    const parsed = handoffConfirmationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '请明确确认已在自己的小红书页面完成暂存或发布' });
    try { return res.json({ ok: true, post: store.confirmHandoff(Number(req.params.id), parsed.data.revision, parsed.data.result, selectionPolicy) }); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/api/drafts/merge', async (req, res) => {
    const parsed = mergeDraftsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '请选择至少两篇草稿和有效照片后重试' });
    try {
      const draft = await serialized(async () => store.mergeDrafts(parsed.data.sources, parsed.data.photoIds, selectionPolicy, parsed.data));
      return res.json({ ok: true, draft });
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/api/drafts/reschedule', (_req, res) => {
    try {
      scheduleDrafts(true);
      return res.json({ ok: true, drafts: store.listDrafts(), schedule: getPublicSettings() });
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.put('/api/drafts/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
      const photoIds = Array.isArray(req.body?.photoIds) ? req.body.photoIds.map(Number) : [];
      const draft = store.updateDraft(id, photoIds, selectionPolicy, {
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        description: typeof req.body?.description === 'string' ? req.body.description : undefined,
        scheduledAt: req.body?.scheduledAt === null || typeof req.body?.scheduledAt === 'string' ? req.body.scheduledAt : undefined,
        locationTag: req.body?.locationTag === null || typeof req.body?.locationTag === 'string' ? req.body.locationTag : undefined,
        topics: Array.isArray(req.body?.topics) ? req.body.topics : undefined,
        verifiedTopics: Array.isArray(req.body?.verifiedTopics) ? normalizeTopics(req.body.verifiedTopics) : undefined,
        locationVerified: typeof req.body?.locationVerified === 'boolean' ? req.body.locationVerified : undefined
      });
      return res.json(draft);
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post(['/api/drafts/:id/save', '/api/drafts/:id/publish', '/api/publish'], (_req, res) =>
    res.status(410).json({ error: '已改为人工交接，请点击“准备发布”，在自己的浏览器中完成暂存或发布，再回系统确认' }));
  app.delete('/api/drafts/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
      store.deleteDraft(id); return res.status(204).end();
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  for (const [route, action] of Object.entries({ 'session-check': xhsLogin.check, 'login/start': xhsLogin.start, 'login/cancel': xhsLogin.cancel, 'login/switch': xhsLogin.switchAccount })) {
    app.post(`/api/xhs/${route}`, async (_req, res) => {
      try { res.set('Cache-Control','no-store').json(await action()); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn({ error: detail.slice(0, 6000) }, 'xhs login unavailable');
        res.status(502).json({ error: xhsErrorMessage(error) });
      }
    });
  }
  app.get('/api/xhs/login/status', async (_req, res) => {
    try { res.set('Cache-Control','no-store').json(await xhsLogin.status()); }
    catch { res.status(502).json({ error: '获取登录状态失败，请重新连接小红书' }); }
  });
  app.get('/api/xhs/login/image', (_req, res) => {
    const image = xhsLogin.image();
    if (!image) return res.status(404).json({ error: '请先获取登录二维码' });
    return res.set('Cache-Control','no-store').type('png').send(image);
  });
  app.post('/api/xhs/lookup', async (req, res) => {
    const kind = req.body?.kind as XhsLookupKind;
    const query = typeof req.body?.query === 'string' ? req.body.query : '';
    if (kind !== 'topic' && kind !== 'location') return res.status(400).json({ error: 'kind 必须是 topic 或 location' });
    if (!query.trim()) return res.status(400).json({ error: '请输入搜索关键词' });
    try {
      const result = await serialized(async () => {
        const publisher = new XhsPublisher();
        try {
          await publisher.open();
          const sample = store.listPhotos(1)[0]?.filePath;
          const candidates = await publisher.lookupCandidates(kind, query, sample);
          return { kind, query: query.trim(), candidates, checkedAt: new Date().toISOString() };
        } finally { await publisher.close(); }
      });
      return res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn({ error: detail.slice(0, 6000), kind }, 'xhs candidate lookup failed');
      return res.status(/未登录|浏览器正在使用|Chrome|连接失败|未找到.*入口/i.test(detail) ? 502 : 400).json({ error: detail });
    }
  });
  app.get('/api/publish-preview', (_req, res) => res.json(store.preview(selectionPolicy)));
  app.get('/api/scan/status', (_req, res) => res.set('Cache-Control', 'no-store').json(getScanStatus()));
  app.put('/api/scan/cursor', async (req, res) => {
    try {
      const result = await moveScanCursor(req.body?.index, req.body?.total);
      return res.status(result.accepted ? 200 : 409).json(result.accepted ? result : { error: '正在移动指针，请稍后重试' });
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      logger.error({ error: String(error) }, 'move scan cursor failed');
      return res.status(500).json({ error: '保存扫描指针失败，请刷新后重试' });
    }
  });
  app.get('/api/selection/status', (_req, res) => res.set('Cache-Control', 'no-store').json(getSelectionStatus()));
  app.post('/api/scan', async (_req, res) => {
    try { const result = startScan(); res.status(result.accepted ? 202 : 200).json(result); }
    catch (error) { logger.error({ error }, 'manual scan failed'); res.status(500).json({ error: String(error) }); }
  });
  app.post('/api/scan/stop', (_req, res) => {
    const result = stopScan(); res.status(result.accepted ? 202 : 200).json(result);
  });
  app.post('/api/scan/resume', (_req, res) => {
    const result = startScan(); res.status(result.accepted ? 202 : 200).json(result);
  });
  app.post('/api/select', async (_req, res) => {
    try { const result = startSelection(); res.status(result.accepted ? 202 : 200).json(result); }
    catch (error) { logger.error({ error }, 'manual selection failed'); return res.status(500).json({ error: String(error) }); }
  });
  app.post('/api/posts/:id/resolve', (req, res) => {
    try {
      const id = Number(req.params.id); if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
      store.resolvePost(id, Boolean(req.body?.published), typeof req.body?.remoteUrl === 'string' ? req.body.remoteUrl : null);
      return res.json(store.listPosts().find(p => p.id === id));
    } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get(['/photos', '/queue', '/publications'], (_req, res) => res.sendFile(path.resolve(process.cwd(), 'public/index.html')));
  app.use(express.static(path.resolve(process.cwd(), 'public'), { index: 'index.html' }));
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

export function startServer() { return createServer().listen(config.PORT, () => logger.info({ port: config.PORT }, 'server started')); }
