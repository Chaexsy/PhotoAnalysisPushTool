import fs from 'node:fs/promises';
import path from 'node:path';
import { imageFiles } from './photo-library.js';
import { config } from './config.js';
import { ANALYSIS_VERSION, assessStory, inspectImage, makeAssessmentThumbnail, totalScore } from './analysis.js';
import { store, selectionPolicy } from './repository.js';
import { reverseGeocode } from './geocode.js';
import { hashFile, readMetadata } from './metadata.js';
import { rejectionReason } from './selection.js';
import { logger } from './logger.js';
import { serialized } from './operations.js';
import type { ImageMetrics, PhotoRecord, VisionAssessment } from './types.js';

export async function analyzePhoto(photo: PhotoRecord, signal?: AbortSignal): Promise<boolean> {
  let metrics: ImageMetrics | null = photo.metrics, assessment: VisionAssessment | null = null;
  try {
    if (store.getPhoto(photo.id)?.manualScoresAt) return true;
    signal?.throwIfAborted();
    const image = metrics ? null : await inspectImage(photo.filePath);
    signal?.throwIfAborted();
    metrics = image?.metrics ?? metrics;
    if (!metrics) throw new Error('无法读取图像分析结果');
    let next = { ...photo, metrics, assessment: null, totalScore: null };
    const localReason = rejectionReason(next, selectionPolicy);
    if (localReason !== '等待视觉模型分析') {
      store.saveAnalysis(photo.id, { metrics, assessment: null, totalScore: null, status: 'rejected', error: localReason, analysisVersion: ANALYSIS_VERSION, outcome: 'skipped' });
      return true;
    }
    assessment = await assessStory(image?.thumbnail ?? await makeAssessmentThumbnail(photo.filePath), signal);
    signal?.throwIfAborted();
    if (store.getPhoto(photo.id)?.manualScoresAt) return true;
    const score = totalScore(metrics.technicalScore, assessment);
    const reason = rejectionReason({ ...photo, metrics, assessment, totalScore: score }, selectionPolicy);
    const missingMetadata = !photo.capturedAt;
    store.saveAnalysis(photo.id, { metrics, assessment, totalScore: score,
      status: reason ? 'rejected' : missingMetadata ? 'needs_metadata' : 'pending',
      error: reason ?? (missingMetadata ? '缺少 EXIF 拍摄时间，不能归入拍摄事件' : null), analysisVersion: ANALYSIS_VERSION });
    return true;
  } catch (error) {
    // A user stop is not an unsuccessful assessment and must not consume one
    // of the photo's five attempts or overwrite an earlier result.
    if (signal?.aborted) throw signal.reason;
    if (store.getPhoto(photo.id)?.manualScoresAt) return true;
    const message = error instanceof Error ? error.message : String(error);
    store.saveAnalysis(photo.id, { metrics, assessment, totalScore: null, status: 'needs_analysis', error: message, analysisVersion: ANALYSIS_VERSION, outcome: 'failed' });
    logger.warn({ id: photo.id, error: message }, 'photo assessment unavailable');
    return false;
  }
}

export type ScanResult = { discovered: number; imported: number; analyzed: number; cached: number; deferred: number; errors: number; draftsCreated: number };
export type ScanPhase = 'idle' | 'discovering' | 'analyzing' | 'grouping' | 'paused' | 'completed' | 'failed';
export type ScanPhoto = {
  photoId: number | null; filePath: string; directory: string; fileName: string;
  capturedAt: string | null; modifiedAt: string | null;
};
export type ScanStatus = {
  running: boolean; phase: ScanPhase; startedAt: string | null; finishedAt: string | null;
  discovered: number; imported: number; analyzed: number; cached: number; deferred: number; errors: number; draftsCreated: number;
  lastResult: ScanResult | null; error: string | null;
  currentPhoto: ScanPhoto | null; currentIndex: number; totalToAnalyze: number; analysisLimit: number;
  progress: ScanProgress | null;
  stopRequested: boolean; currentTask: 'retry' | 'scan' | null;
};
export type ScanProgress = {
  total: number; completed: number; failed: number; unscanned: number;
  pointerIndex: number; pointerPercent: number;
  segments: { status: 'unscanned' | 'completed' | 'failed'; count: number }[];
};
const emptyScanResult = (): ScanResult => ({ discovered: 0, imported: 0, analyzed: 0, cached: 0, deferred: 0, errors: 0, draftsCreated: 0 });
const scoringLimit = () => Math.min(config.MAX_SCORING_PHOTOS_PER_RUN, 500);
const scanDetails = () => ({ currentPhoto: null, currentIndex: 0, totalToAnalyze: 0, analysisLimit: scoringLimit(), progress: null as ScanProgress | null, stopRequested: false, currentTask: null });
let scanState: ScanStatus = { running: false, phase: 'idle', startedAt: null, finishedAt: null, ...emptyScanResult(), ...scanDetails(), lastResult: null, error: null };
let currentScan: Promise<ScanResult> | null = null;
type Work = { photoId: number; mode: 'retry' | 'scan' | 'new' };
type Checkpoint = { status: ScanStatus; pending: Work[] | null; limit?: number };
let pendingWork: Work[] | null = null;
let restored = false;
let scanController: AbortController | null = null;
let cursorMoving = false;
let batchLimit = scoringLimit();

function restoreScan(): void {
  if (restored) return;
  restored = true;
  const saved = store.getScanSession<Checkpoint>();
  if (saved.session) {
    scanState = { ...saved.session.status, running: false, phase: 'paused', stopRequested: false };
    pendingWork = saved.session.pending;
    batchLimit = saved.session.limit ?? saved.session.status.analysisLimit;
  } else if (saved.paused) scanState.phase = 'paused';
}

function persistScan(paused: boolean): void {
  store.saveScanSession({ status: { ...scanState, progress: null }, pending: pendingWork, limit: batchLimit } satisfies Checkpoint, paused);
}

function scanResult(): ScanResult {
  const { discovered, imported, analyzed, cached, deferred, errors, draftsCreated } = scanState;
  return { discovered, imported, analyzed, cached, deferred, errors, draftsCreated };
}

export function getScanStatus(): ScanStatus {
  restoreScan();
  return { ...scanState, progress: store.scanProgress(), currentPhoto: scanState.currentPhoto ? { ...scanState.currentPhoto } : null, lastResult: scanState.lastResult ? { ...scanState.lastResult } : null };
}

function scanPhoto(filePath: string, photo?: PhotoRecord, mtimeMs?: number): ScanPhoto {
  return { photoId: photo?.id ?? null, filePath, directory: path.dirname(filePath), fileName: path.basename(filePath),
    capturedAt: photo?.capturedAt ?? null, modifiedAt: mtimeMs === undefined ? null : new Date(mtimeMs).toISOString() };
}

export function scanPhotos(resume = false): Promise<ScanResult> {
  restoreScan();
  if (cursorMoving) return Promise.resolve(scanResult());
  // A scheduled run must respect an explicit user stop, including after a
  // restart. Only the manual continue action resumes a paused batch.
  if (!currentScan && scanState.phase === 'paused' && !resume) return Promise.resolve(scanResult());
  if (!currentScan) {
    const continuing = scanState.phase === 'paused' && scanState.startedAt !== null;
    if (!continuing) {
      pendingWork = null;
      batchLimit = scoringLimit();
      scanState = { running: true, phase: 'discovering', startedAt: new Date().toISOString(), finishedAt: null, ...emptyScanResult(), ...scanDetails(), lastResult: scanState.lastResult, error: null };
    } else scanState = { ...scanState, running: true, phase: 'discovering', stopRequested: false, finishedAt: null, error: null };
    const controller = scanController = new AbortController();
    persistScan(false);
    currentScan = serialized(() => scanLibrary(controller.signal))
      .then(result => {
        scanState = { ...scanState, running: false, phase: 'completed', finishedAt: new Date().toISOString(), ...result, lastResult: result, currentTask: null, error: null };
        store.saveScanSession(null, false); pendingWork = null;
        return result;
      })
      .catch(error => {
        scanState = { ...scanState, running: false, phase: controller.signal.aborted ? 'paused' : 'failed', stopRequested: false, finishedAt: new Date().toISOString(), error: controller.signal.aborted ? null : error instanceof Error ? error.message : String(error) };
        persistScan(true);
        if (!controller.signal.aborted) throw error;
        return scanResult();
      })
      .finally(() => { currentScan = null; scanController = null; });
  }
  return currentScan;
}

export function startScan(): { accepted: boolean; status: ScanStatus } {
  if (currentScan || cursorMoving) return { accepted: false, status: getScanStatus() };
  void scanPhotos(true).catch(error => logger.error({ error: String(error) }, 'manual scan failed'));
  return { accepted: true, status: getScanStatus() };
}

export function stopScan(): { accepted: boolean; status: ScanStatus } {
  restoreScan();
  if (!currentScan || scanState.stopRequested) return { accepted: false, status: getScanStatus() };
  scanState.stopRequested = true;
  persistScan(true);
  scanController?.abort(new Error('用户停止扫描'));
  return { accepted: true, status: getScanStatus() };
}

export async function moveScanCursor(index: number, total: number): Promise<{ accepted: boolean; resumed: boolean; status: ScanStatus }> {
  restoreScan();
  if (cursorMoving) return { accepted: false, resumed: false, status: getScanStatus() };
  // Resolve the stable photo key before interrupting anything. Invalid or stale
  // positions must leave a running batch completely untouched.
  const target = store.scanCursorTarget(index, total);
  const continuing = Boolean(currentScan || (scanState.phase === 'paused' && scanState.startedAt));
  cursorMoving = true;
  const resume = Boolean(currentScan && !scanState.stopRequested);
  try {
    if (currentScan) { stopScan(); await currentScan.catch(() => undefined); }
    store.setManualScanCursor(store.getPhoto(target.id) ?? target);
    pendingWork = null;
    if (!continuing) {
      batchLimit = scoringLimit();
      scanState = { ...scanState, ...emptyScanResult(), ...scanDetails(), startedAt: null, finishedAt: null };
    }
    scanState = { ...scanState, phase: 'paused', running: false, currentPhoto: null, currentTask: null, currentIndex: scanState.analyzed, stopRequested: false, error: null };
    persistScan(true);
  } finally { cursorMoving = false; }
  if (resume) startScan();
  return { accepted: true, resumed: resume, status: getScanStatus() };
}

async function scanLibrary(signal: AbortSignal): Promise<ScanResult> {
  signal.throwIfAborted();
  // Recheck the directory on continue, without losing the remaining work or
  // resetting the original batch's scoring quota.
  scanState.discovered = 0; scanState.cached = 0; scanState.deferred = 0;
  const result = scanResult();
  const present = new Map<number, string>();
  try {
    for await (const filePath of imageFiles(config.PHOTO_ROOT)) {
      signal.throwIfAborted();
      result.discovered++;
      scanState.discovered = result.discovered;
      scanState.currentPhoto = scanPhoto(filePath);
      try {
        const before = await fs.stat(filePath);
        scanState.currentPhoto.modifiedAt = new Date(before.mtimeMs).toISOString();
        if (Date.now() - before.mtimeMs < config.FILE_SETTLE_SECONDS * 1000) { result.deferred++; scanState.deferred = result.deferred; continue; }
        let photo = store.cachedPhoto(filePath, before.size, before.mtimeMs);
        if (photo) { result.cached++; scanState.cached = result.cached; }
        else {
          const fileHash = await hashFile(filePath);
          const after = await fs.stat(filePath);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            result.deferred++; scanState.deferred = result.deferred; continue;
          }
          photo = store.findByHash(fileHash);
          if (!photo) {
            const metadata = await readMetadata(filePath);
            scanState.currentPhoto.capturedAt = metadata.capturedAt?.toISOString() ?? null;
            const locationName = await reverseGeocode(metadata.latitude, metadata.longitude);
            photo = store.importPhoto({ filePath, fileHash, capturedAt: metadata.capturedAt?.toISOString() ?? null,
              latitude: metadata.latitude, longitude: metadata.longitude, locationName,
              title: config.DEFAULT_TITLE, description: config.DEFAULT_DESCRIPTION });
            result.imported++; scanState.imported = result.imported;
          }
          store.cacheFile(filePath, before.size, before.mtimeMs, photo.id);
        }
        present.set(photo.id, filePath);
        scanState.currentPhoto = scanPhoto(filePath, photo, before.mtimeMs);
        if (photo.filePath !== filePath) store.updatePath(photo.id, filePath);
        if (!photo.exif) {
          const metadata = await readMetadata(filePath);
          store.updateMetadata(photo.id, { ...metadata, locationName: photo.locationName });
          photo = store.getPhoto(photo.id)!;
          scanState.currentPhoto = scanPhoto(filePath, photo, before.mtimeMs);
        }
      } catch (error) { if (signal.aborted) throw signal.reason; result.errors++; scanState.errors = result.errors; logger.warn({ error: String(error), filePath }, 'photo import failed'); }
    }
  } catch (error) { if (signal.aborted) throw signal.reason; result.errors++; scanState.errors = result.errors; logger.error({ error: String(error), root: config.PHOTO_ROOT }, 'photo scan failed'); }
  // Analyze unique database records after discovery, so copies never spend multiple slots.
  scanState.phase = 'analyzing';
  if (pendingWork === null) {
    const remaining = Math.max(0, Math.min(batchLimit, scoringLimit()) - scanState.analyzed);
    pendingWork = store.scanWork(remaining, new Set(present.keys())).map(({ photo, mode }) => ({ photoId: photo.id, mode }));
    scanState.totalToAnalyze = scanState.analyzed + pendingWork.length;
  }
  persistScan(false);
  if (!pendingWork.length) scanState.currentPhoto = null;
  while (pendingWork.length) {
    signal.throwIfAborted();
    const work = pendingWork[0];
    const photo = store.getPhoto(work.photoId);
    if (!photo || !present.has(photo.id) || photo.status !== 'needs_analysis' || photo.assessment || photo.analysisOutcome === 'assessed' || photo.analysisOutcome === 'skipped' || photo.analysisAttempts >= 5) {
      pendingWork.shift(); persistScan(false); continue;
    }
    const filePath = present.get(photo.id)!;
    scanState.currentIndex = scanState.totalToAnalyze - pendingWork.length + 1;
    scanState.currentPhoto = scanPhoto(filePath, photo);
    scanState.currentTask = work.mode === 'retry' ? 'retry' : 'scan';
    try {
      const before = await fs.stat(filePath);
      scanState.currentPhoto.modifiedAt = new Date(before.mtimeMs).toISOString();
      const analysisSucceeded = await analyzePhoto({ ...photo, filePath }, signal); result.analyzed++; scanState.analyzed = result.analyzed;
      if (!analysisSucceeded) { result.errors++; scanState.errors = result.errors; }
      const after = await fs.stat(filePath);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        store.forgetFile(filePath);
        store.saveAnalysis(photo.id, { metrics: null, assessment: null, totalScore: null, status: 'needs_analysis', error: '文件在分析过程中变化，下次重新读取', analysisVersion: null, outcome: null });
      } else if (work.mode === 'scan') store.advanceScanCursor(photo);
    } catch (error) { if (signal.aborted) throw signal.reason; result.errors++; scanState.errors = result.errors; logger.warn({ id: photo.id, error: String(error) }, 'photo analysis failed'); }
    pendingWork.shift(); persistScan(false);
  }
  logger.info(result, 'photo scoring scan completed'); return result;
}
