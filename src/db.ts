import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { batchFrom, distanceMeters, isDuplicate, planBatches, rejectionReason, validateSelection, type SelectionPolicy } from './selection.js';
import { manualScoresSchema, totalScore } from './scores.js';
import { MAX_DESCRIPTION_LENGTH } from './constants.js';
import { normalizeTopics } from './xhs-metadata.js';
import type { PhotoRecord, PhotoStatus, PostRecord, PostStatus, PublishBatch, ShootingEvent, PhotoLibraryItem, PhotoLibraryQuery } from './types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

type Row = Record<string, any>;
type ImportPhoto = Pick<PhotoRecord, 'filePath' | 'fileHash' | 'capturedAt' | 'latitude' | 'longitude' | 'locationName' | 'title' | 'description'>;

function isPrePublishFailure(error: string | null): boolean {
  if (!error) return false;
  return /browserType\.launchPersistentContext|locator\.setInputFiles|小红书未登录|找不到发布按钮|图文上传入口未找到/i.test(error);
}

function mapPhoto(row: Row): PhotoRecord {
  return {
    id: row.id, filePath: row.file_path, fileHash: row.file_hash, capturedAt: row.captured_at,
    latitude: row.latitude, longitude: row.longitude, locationName: row.location_name,
    title: row.title, description: row.description, status: row.status, publishedAt: row.published_at,
    remoteUrl: row.remote_url, error: row.error, eventId: row.event_id,
    analysisAttemptedAt: row.analysis_attempted_at ?? null,
    analysisOutcome: row.analysis_outcome ?? null,
    metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null,
    assessment: row.assessment_json ? JSON.parse(row.assessment_json) : null,
    totalScore: row.total_score, analysisVersion: row.analysis_version,
    analysisAttempts: Number(row.analysis_attempts ?? 0),
    manualScoresAt: row.manual_scores_at ?? null, scoreRevision: Number(row.score_revision ?? 0),
    exif: row.exif_json ? JSON.parse(row.exif_json) : null
  };
}

export class PhotoStore {
  readonly db: DatabaseSyncInstance;
  constructor(filePath: string) {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, file_hash TEXT NOT NULL UNIQUE,
        captured_at TEXT, latitude REAL, longitude REAL, location_name TEXT, title TEXT NOT NULL,
        description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'needs_analysis', published_at TEXT,
        remote_url TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
        latitude REAL, longitude REAL, location_name TEXT, location_available INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id),
        channel TEXT NOT NULL DEFAULT 'xiaohongshu', orientation TEXT NOT NULL, theme TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL, remote_url TEXT, error TEXT, scheduled_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        published_at TEXT, draft_saved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS post_photos (
        post_id INTEGER NOT NULL REFERENCES posts(id), photo_id INTEGER NOT NULL REFERENCES photos(id),
        position INTEGER NOT NULL, PRIMARY KEY(post_id, photo_id)
      );
      CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status);
      CREATE INDEX IF NOT EXISTS idx_posts_event ON posts(event_id, status);
      CREATE TABLE IF NOT EXISTS file_cache (
        file_path TEXT PRIMARY KEY, size REAL NOT NULL, mtime_ms REAL NOT NULL,
        photo_id INTEGER NOT NULL REFERENCES photos(id)
      );
      CREATE TABLE IF NOT EXISTS library_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL UNIQUE,
        directory TEXT NOT NULL, file_name TEXT NOT NULL, size REAL NOT NULL, mtime_ms REAL NOT NULL,
        discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_library_directory ON library_files(directory);
      CREATE TABLE IF NOT EXISTS scan_state (
        id INTEGER PRIMARY KEY CHECK (id=1), cursor_captured_at TEXT, cursor_photo_id INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO scan_state(id) VALUES (1) ON CONFLICT(id) DO NOTHING;
    `);
    const columns = new Set((this.db.prepare('PRAGMA table_info(photos)').all() as Row[]).map(r => r.name));
    const legacy = !columns.has('event_id');
    for (const [name, type] of Object.entries({ event_id: 'INTEGER', metrics_json: 'TEXT', assessment_json: 'TEXT', total_score: 'REAL', analysis_version: 'TEXT', analysis_attempted_at: 'TEXT', analysis_attempts: 'INTEGER NOT NULL DEFAULT 0', analysis_outcome: 'TEXT', exif_json: 'TEXT', manual_scores_at: 'TEXT', score_revision: 'INTEGER NOT NULL DEFAULT 0' })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE photos ADD COLUMN ${name} ${type}`);
    }
    // Older databases predate the explicit outcome/attempt counters. Backfill
    // them once so the queue and progress bar reflect work already completed.
    this.db.exec(`UPDATE photos SET analysis_outcome=CASE
      WHEN assessment_json IS NOT NULL THEN 'assessed'
      WHEN analysis_attempted_at IS NOT NULL AND status='rejected' AND metrics_json IS NOT NULL THEN 'skipped'
      WHEN analysis_attempted_at IS NOT NULL THEN 'failed'
      ELSE analysis_outcome END
      WHERE analysis_outcome IS NULL`);
    this.db.exec(`UPDATE photos SET analysis_attempts=1
      WHERE COALESCE(analysis_attempts,0)=0 AND analysis_outcome IS NOT NULL`);
    if (legacy) this.db.exec("UPDATE photos SET status='uncertain', error='旧版本未验证发布结果，请人工确认' WHERE status IN ('publishing','failed')");
    const postColumns = new Set((this.db.prepare('PRAGMA table_info(posts)').all() as Row[]).map(r => r.name));
    if (!postColumns.has('channel')) this.db.exec("ALTER TABLE posts ADD COLUMN channel TEXT NOT NULL DEFAULT 'xiaohongshu'");
    if (!postColumns.has('scheduled_at')) this.db.exec('ALTER TABLE posts ADD COLUMN scheduled_at TEXT');
    if (!postColumns.has('location_tag')) this.db.exec('ALTER TABLE posts ADD COLUMN location_tag TEXT');
    if (!postColumns.has('topics_json')) this.db.exec('ALTER TABLE posts ADD COLUMN topics_json TEXT');
    if (!postColumns.has('verified_topics_json')) this.db.exec('ALTER TABLE posts ADD COLUMN verified_topics_json TEXT');
    if (!postColumns.has('location_verified')) this.db.exec('ALTER TABLE posts ADD COLUMN location_verified INTEGER NOT NULL DEFAULT 0');
    if (!postColumns.has('draft_saved_at')) this.db.exec('ALTER TABLE posts ADD COLUMN draft_saved_at TEXT');
    if (!postColumns.has('xhs_draft_id')) this.db.exec('ALTER TABLE posts ADD COLUMN xhs_draft_id TEXT');
    if (!postColumns.has('xhs_draft_account')) this.db.exec('ALTER TABLE posts ADD COLUMN xhs_draft_account TEXT');
    if (!postColumns.has('merged')) this.db.exec('ALTER TABLE posts ADD COLUMN merged INTEGER NOT NULL DEFAULT 0');
    if (!postColumns.has('revision')) this.db.exec('ALTER TABLE posts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    if (!postColumns.has('manual_confirmed_at')) this.db.exec('ALTER TABLE posts ADD COLUMN manual_confirmed_at TEXT');
    const eventColumns = new Set((this.db.prepare('PRAGMA table_info(events)').all() as Row[]).map(r => r.name));
    if (!eventColumns.has('location_available')) this.db.exec('ALTER TABLE events ADD COLUMN location_available INTEGER NOT NULL DEFAULT 1');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_photos_path ON photos(file_path)');
    const scanColumns = new Set((this.db.prepare('PRAGMA table_info(scan_state)').all() as Row[]).map(r => r.name));
    if (!scanColumns.has('paused')) this.db.exec('ALTER TABLE scan_state ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
    if (!scanColumns.has('session_json')) this.db.exec('ALTER TABLE scan_state ADD COLUMN session_json TEXT');
    if (!scanColumns.has('cursor_manual')) this.db.exec('ALTER TABLE scan_state ADD COLUMN cursor_manual INTEGER NOT NULL DEFAULT 0');
    // Older builds recorded failures that happened before the XHS publish
    // button was clicked as “uncertain”. They are safe to put back in the
    // draft queue because no external note could have been created.
    this.recoverPrePublishFailures();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getPhoto(id: number): PhotoRecord | null {
    const row = this.db.prepare('SELECT * FROM photos WHERE id=?').get(id) as Row | undefined;
    return row ? mapPhoto(row) : null;
  }
  findByHash(hash: string): PhotoRecord | null {
    const row = this.db.prepare('SELECT * FROM photos WHERE file_hash=?').get(hash) as Row | undefined;
    return row ? mapPhoto(row) : null;
  }
  cachedPhoto(filePath: string, size: number, mtimeMs: number): PhotoRecord | null {
    const row = this.db.prepare('SELECT photo_id FROM file_cache WHERE file_path=? AND size=? AND mtime_ms=?')
      .get(filePath, size, mtimeMs) as Row | undefined;
    return row ? this.getPhoto(row.photo_id) : null;
  }
  cacheFile(filePath: string, size: number, mtimeMs: number, photoId: number): void {
    this.db.prepare(`INSERT INTO file_cache(file_path,size,mtime_ms,photo_id) VALUES (?,?,?,?)
      ON CONFLICT(file_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,photo_id=excluded.photo_id`)
      .run(filePath, size, mtimeMs, photoId);
  }
  forgetFile(filePath: string): void { this.db.prepare('DELETE FROM file_cache WHERE file_path=?').run(filePath); }
  listPhotos(limit?: number): PhotoRecord[] {
    const sql = 'SELECT * FROM photos ORDER BY COALESCE(captured_at,created_at),id';
    const rows = limit === undefined ? this.db.prepare(sql).all() : this.db.prepare(`${sql} LIMIT ?`).all(limit);
    return (rows as Row[]).map(mapPhoto);
  }
  eventPhotos(eventId: number): PhotoRecord[] {
    return (this.db.prepare('SELECT * FROM photos WHERE event_id=? ORDER BY total_score DESC,id').all(eventId) as Row[]).map(mapPhoto);
  }
  eventPhotoSummaries(eventId: number) {
    return (this.db.prepare('SELECT id,file_path,status,total_score,metrics_json FROM photos WHERE event_id=? ORDER BY total_score DESC,id').all(eventId) as Row[]).map(row => {
      const metrics = row.metrics_json ? JSON.parse(row.metrics_json) : null;
      return {
        id: row.id,
        filePath: row.file_path,
        status: row.status as PhotoStatus,
        totalScore: row.total_score ?? null,
        metrics: metrics ? { width: metrics.width, height: metrics.height, orientation: metrics.orientation } : null
      };
    });
  }

  replaceLibraryFiles(files: { filePath: string; size: number; mtimeMs: number }[]): void {
    this.transaction(() => {
      const current = new Set(files.map(file => file.filePath));
      const existing = this.db.prepare('SELECT id,file_path FROM library_files').all() as Row[];
      const remove = this.db.prepare('DELETE FROM library_files WHERE id=?');
      for (const row of existing) if (!current.has(row.file_path)) remove.run(row.id);
      const upsert = this.db.prepare(`INSERT INTO library_files(file_path,directory,file_name,size,mtime_ms) VALUES (?,?,?,?,?)
        ON CONFLICT(file_path) DO UPDATE SET directory=excluded.directory,file_name=excluded.file_name,size=excluded.size,mtime_ms=excluded.mtime_ms`);
      for (const file of files) upsert.run(file.filePath, path.dirname(file.filePath), path.basename(file.filePath), file.size, file.mtimeMs);
    });
  }

  libraryFile(fileId: number): { filePath: string; size: number; mtimeMs: number } | null {
    const row = this.db.prepare('SELECT file_path,size,mtime_ms FROM library_files WHERE id=?').get(fileId) as Row | undefined;
    return row ? { filePath: row.file_path, size: row.size, mtimeMs: row.mtime_ms } : null;
  }

  searchPhotoLibrary(query: PhotoLibraryQuery) {
    // Inventory preserves every physical file; only an unchanged cached file inherits its content analysis.
    const base = `WITH records AS (
      SELECT f.id AS file_id,f.file_path AS library_path,f.directory,f.file_name,f.size,f.mtime_ms,f.discovered_at,p.*,
        CASE WHEN p.assessment_json IS NOT NULL THEN 'assessed'
          WHEN p.analysis_outcome IS NOT NULL THEN p.analysis_outcome
          WHEN p.analysis_attempted_at IS NULL AND p.metrics_json IS NULL THEN 'unassessed'
          WHEN p.status='rejected' AND p.metrics_json IS NOT NULL THEN 'skipped'
          WHEN p.error IS NOT NULL THEN 'failed' ELSE 'unassessed' END AS evaluation_state
      FROM library_files f LEFT JOIN file_cache c ON c.file_path=f.file_path AND c.size=f.size AND c.mtime_ms=f.mtime_ms
      LEFT JOIN photos p ON p.id=c.photo_id
    ), catalog AS (SELECT *,CASE WHEN evaluation_state='failed' THEN 'failed'
      WHEN analysis_attempted_at IS NOT NULL OR metrics_json IS NOT NULL THEN 'scanned' ELSE 'unscanned' END AS scan_state FROM records)`;
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.fileId !== undefined) { clauses.push('file_id=?'); params.push(query.fileId); }
    const like = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
    if (query.directory?.trim()) {
      const directory = query.directory.trim().replace(/\/$/, '');
      clauses.push("(directory=? OR directory LIKE ? ESCAPE '\\')");
      params.push(directory, `${directory.replace(/[\\%_]/g, '\\$&')}/%`);
    }
    const dateExpr = query.timeField === 'modified' ? 'mtime_ms' : query.timeField === 'analyzed' ? 'julianday(analysis_attempted_at)' : 'julianday(captured_at)';
    const dateValue = (ms: number) => query.timeField === 'modified' ? ms : ms / 86400000 + 2440587.5;
    if (query.fromMs !== undefined) { clauses.push(`${dateExpr} >= ?`); params.push(dateValue(query.fromMs)); }
    if (query.toMs !== undefined) { clauses.push(`${dateExpr} < ?`); params.push(dateValue(query.toMs)); }
    if (query.location?.trim()) {
      clauses.push("(location_name LIKE ? ESCAPE '\\' OR CAST(latitude AS TEXT) LIKE ? ESCAPE '\\' OR CAST(longitude AS TEXT) LIKE ? ESCAPE '\\')");
      const term = like(query.location.trim()); params.push(term, term, term);
    }
    if (query.hasLocation === 'yes') clauses.push("(NULLIF(location_name,'') IS NOT NULL OR (latitude IS NOT NULL AND longitude IS NOT NULL))");
    if (query.hasLocation === 'no') clauses.push("NULLIF(location_name,'') IS NULL AND (latitude IS NULL OR longitude IS NULL)");
    if (query.scan === 'scanned') clauses.push("scan_state IN ('scanned','failed')");
    if (query.scan === 'unscanned') clauses.push("scan_state='unscanned'");
    if (query.scan === 'failed') clauses.push("scan_state='failed'");
    if (query.evaluated && query.evaluated !== 'all') { clauses.push('evaluation_state=?'); params.push(query.evaluated); }
    // Keep the old `rated` value as a backwards-compatible API alias while the
    // UI exposes the more useful score bands.
    if (query.rated === 'rated') clauses.push('total_score IS NOT NULL');
    if (query.rated === 'unrated') clauses.push('(assessment_json IS NULL OR total_score IS NULL)');
    if (query.rated === 'lt65') clauses.push('total_score IS NOT NULL AND total_score < 65');
    if (query.rated === '65to75') clauses.push('total_score >= 65 AND total_score < 75');
    if (query.rated === '75to85') clauses.push('total_score >= 75 AND total_score <= 85');
    if (query.rated === 'gt85') clauses.push('total_score > 85');
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = Number((this.db.prepare(`${base} SELECT COUNT(*) AS count FROM catalog${where}`).get(...params) as Row).count);
    const order = query.sort === 'score' ? 'total_score DESC,file_id DESC' : `${dateExpr} ${query.sort === 'oldest' ? 'ASC' : 'DESC'},file_id DESC`;
    const rows = this.db.prepare(`${base} SELECT * FROM catalog${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset) as Row[];
    const directories = this.db.prepare('SELECT directory,COUNT(*) AS count FROM library_files GROUP BY directory ORDER BY directory').all();
    const counts = this.db.prepare(`${base} SELECT COUNT(*) AS total,
      SUM(scan_state!='unscanned') AS scanned,SUM(scan_state='unscanned') AS unscanned,
      SUM(evaluation_state='assessed') AS assessed,SUM(evaluation_state='failed') AS failed,
      SUM(evaluation_state='skipped') AS skipped FROM catalog`).get() as Row;
    return { photos: rows.map(row => ({
      fileId: row.file_id, photoId: row.id ?? null, filePath: row.library_path,
      directory: row.directory, fileName: row.file_name, size: row.size,
      modifiedAt: new Date(row.mtime_ms).toISOString(), discoveredAt: `${row.discovered_at.replace(' ', 'T')}Z`,
      scanState: row.scan_state, evaluationState: row.evaluation_state,
      capturedAt: row.captured_at ?? null, latitude: row.latitude ?? null, longitude: row.longitude ?? null,
      locationName: row.location_name ?? null, status: row.status ?? 'not_imported', error: row.error ?? null,
      analysisAttemptedAt: row.analysis_attempted_at ?? null, analysisVersion: row.analysis_version ?? null,
      manualScoresAt: row.manual_scores_at ?? null, scoreRevision: Number(row.score_revision ?? 0),
      totalScore: row.total_score ?? null, metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null,
      assessment: row.assessment_json ? JSON.parse(row.assessment_json) : null,
      exif: row.exif_json ? JSON.parse(row.exif_json) : null
    }) as PhotoLibraryItem), total, directories, counts };
  }
  analysisQueue(): PhotoRecord[] {
    return (this.db.prepare(`SELECT p.* FROM photos p
      LEFT JOIN (SELECT photo_id,MAX(mtime_ms) AS modified_ms FROM file_cache GROUP BY photo_id) c ON c.photo_id=p.id
      WHERE p.status='needs_analysis' AND p.assessment_json IS NULL AND COALESCE(p.analysis_attempts,0) < 5
      ORDER BY julianday(p.captured_at) IS NULL,julianday(p.captured_at) DESC,c.modified_ms DESC,p.id DESC`).all() as Row[]).map(mapPhoto);
  }
  private scanOrderClause = 'julianday(captured_at) IS NOT NULL ASC,julianday(captured_at) ASC,id ASC';
  private scanKey(photo: Pick<PhotoRecord, 'capturedAt' | 'id'>): [number, number] {
    const timestamp = photo.capturedAt ? Date.parse(photo.capturedAt) : NaN;
    return [Number.isFinite(timestamp) ? timestamp : -Infinity, photo.id];
  }
  private compareScanKey(a: Pick<PhotoRecord, 'capturedAt' | 'id'>, b: Pick<PhotoRecord, 'capturedAt' | 'id'>): number {
    const [ac, ai] = this.scanKey(a), [bc, bi] = this.scanKey(b);
    return (ac === bc ? 0 : ac < bc ? -1 : 1) || ai - bi;
  }
  getScanCursor(): { capturedAt: string | null; photoId: number | null } {
    const row = this.db.prepare('SELECT cursor_captured_at,cursor_photo_id FROM scan_state WHERE id=1').get() as Row | undefined;
    return { capturedAt: row?.cursor_captured_at ?? null, photoId: row?.cursor_photo_id ?? null };
  }
  setScanCursor(photo: Pick<PhotoRecord, 'capturedAt' | 'id'>): void {
    this.db.prepare('UPDATE scan_state SET cursor_captured_at=?,cursor_photo_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=1').run(photo.capturedAt, photo.id);
  }
  scanCursorTarget(index: number, total: number): Pick<PhotoRecord, 'capturedAt' | 'id'> {
    const rows = this.db.prepare(`SELECT id,captured_at FROM photos ORDER BY ${this.scanOrderClause}`).all() as Row[];
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 0 || index >= total) throw new RangeError('指针位置无效');
    if (total !== rows.length) throw new RangeError('照片队列已变化，请刷新后重新移动指针');
    return { id: Number(rows[index].id), capturedAt: rows[index].captured_at };
  }
  setManualScanCursor(photo: Pick<PhotoRecord, 'capturedAt' | 'id'>): void {
    this.db.prepare('UPDATE scan_state SET cursor_captured_at=?,cursor_photo_id=?,cursor_manual=1,updated_at=CURRENT_TIMESTAMP WHERE id=1').run(photo.capturedAt, photo.id);
  }
  getScanSession<T>(): { paused: boolean; session: T | null } {
    const row = this.db.prepare('SELECT paused,session_json FROM scan_state WHERE id=1').get() as Row;
    return { paused: Boolean(row.paused), session: row.session_json ? JSON.parse(row.session_json) as T : null };
  }
  saveScanSession(session: unknown, paused: boolean): void {
    this.db.prepare('UPDATE scan_state SET paused=?,session_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=1')
      .run(paused ? 1 : 0, session === null ? null : JSON.stringify(session));
  }
  resetScanCursorToCompletedTail(): void {
    const rows = this.db.prepare(`SELECT id,captured_at,analysis_outcome,assessment_json FROM photos ORDER BY ${this.scanOrderClause}`).all() as Row[];
    let first = rows.length;
    while (first > 0 && (rows[first - 1].assessment_json !== null || ['assessed', 'skipped'].includes(rows[first - 1].analysis_outcome))) first--;
    const boundary = rows[first];
    this.db.prepare('UPDATE scan_state SET cursor_captured_at=?,cursor_photo_id=?,paused=1,session_json=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=1')
      .run(boundary?.captured_at ?? null, boundary?.id ?? null);
  }
  advanceScanCursor(photo: Pick<PhotoRecord, 'capturedAt' | 'id'>): void {
    const cursor = this.getScanCursor();
    if (cursor.photoId !== null && this.compareScanKey(photo, { id: cursor.photoId, capturedAt: cursor.capturedAt }) > 0) return;
    const rows = (this.db.prepare(`SELECT id,captured_at FROM photos ORDER BY ${this.scanOrderClause}`).all() as Row[]).reverse();
    const next = rows.find(row => this.compareScanKey({ id: row.id, capturedAt: row.captured_at }, photo) < 0);
    // ID zero is a stable marker before the oldest photo; null means the tail.
    this.setScanCursor(next ? { id: next.id, capturedAt: next.captured_at } : { id: 0, capturedAt: null });
  }
  scanWork(limit: number, availableIds?: ReadonlySet<number>): { photo: PhotoRecord; mode: 'retry' | 'scan' | 'new' }[] {
    const rows = this.db.prepare(`SELECT p.* FROM photos p WHERE p.status='needs_analysis' AND p.assessment_json IS NULL AND COALESCE(p.analysis_outcome,'') NOT IN ('assessed','skipped') AND COALESCE(p.analysis_attempts,0) < 5`).all() as Row[];
    const photos = rows.filter(row => !availableIds || availableIds.has(Number(row.id))).map(mapPhoto);
    const newestFirst = (a: PhotoRecord, b: PhotoRecord) => this.compareScanKey(b, a);
    const cursor = this.getScanCursor();
    const cursorPhoto = cursor.photoId !== null ? { id: cursor.photoId, capturedAt: cursor.capturedAt } : null;
    const behind = (photo: PhotoRecord) => cursorPhoto !== null && this.compareScanKey(photo, cursorPhoto) > 0;
    const retries = photos.filter(photo => behind(photo) && photo.analysisOutcome === 'failed').sort(newestFirst);
    // A manually selected start must not be overridden by untouched photos to
    // its right. Keep automatic import catch-up only for the legacy auto cursor.
    const manual = (this.db.prepare('SELECT cursor_manual FROM scan_state WHERE id=1').get() as Row).cursor_manual;
    const added = manual ? [] : photos.filter(photo => behind(photo) && photo.analysisOutcome === null).sort(newestFirst);
    // Failures before the cursor are visited only when the normal sweep reaches
    // them, never lifted ahead of the untouched photos between them and it.
    const forward = photos.filter(photo => !behind(photo) && (photo.analysisOutcome === null || photo.analysisOutcome === 'failed')).sort(newestFirst);
    return [
      ...retries.map(photo => ({ photo, mode: 'retry' as const })),
      ...added.map(photo => ({ photo, mode: 'new' as const })),
      ...forward.map(photo => ({ photo, mode: 'scan' as const }))
    ].slice(0, limit);
  }
  scanCandidates(limit: number): PhotoRecord[] {
    return this.scanWork(limit).map(item => item.photo);
  }
  scanProgress() {
    const rows = this.db.prepare(`SELECT id,captured_at,assessment_json,analysis_outcome,analysis_attempts,status FROM photos ORDER BY ${this.scanOrderClause}`).all() as Row[];
    const states = rows.map(row => {
      if (row.analysis_outcome === 'failed') return 'failed';
      if (row.analysis_outcome === 'assessed' || row.analysis_outcome === 'skipped' || row.assessment_json !== null || (row.status !== 'needs_analysis' && row.analysis_attempts > 0)) return 'completed';
      return 'unscanned';
    });
    const cursor = this.getScanCursor();
    let pointerIndex = rows.length;
    if (cursor.photoId === 0) pointerIndex = 0;
    else if (cursor.photoId !== null) {
      const found = rows.findIndex(row => Number(row.id) === Number(cursor.photoId));
      pointerIndex = found >= 0 ? found : rows.findIndex(row => this.compareScanKey({ id: Number(row.id), capturedAt: row.captured_at }, { id: Number(cursor.photoId), capturedAt: cursor.capturedAt }) > 0);
      if (pointerIndex < 0) pointerIndex = rows.length;
    }
    const segments: { status: 'unscanned' | 'completed' | 'failed'; count: number }[] = [];
    states.forEach(status => { const last = segments.at(-1); if (last?.status === status) last.count++; else segments.push({ status: status as 'unscanned' | 'completed' | 'failed', count: 1 }); });
    return {
      total: states.length, completed: states.filter(status => status === 'completed').length,
      failed: states.filter(status => status === 'failed').length, unscanned: states.filter(status => status === 'unscanned').length,
      pointerIndex, pointerPercent: states.length ? Math.min(100, Math.max(0, pointerIndex / states.length * 100)) : 100,
      segments
    };
  }
  importPhoto(input: ImportPhoto): PhotoRecord {
    this.db.prepare(`INSERT INTO photos(file_path,file_hash,captured_at,latitude,longitude,location_name,title,description)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(file_hash) DO UPDATE SET file_path=excluded.file_path, updated_at=CURRENT_TIMESTAMP`)
      .run(input.filePath, input.fileHash, input.capturedAt, input.latitude, input.longitude, input.locationName, input.title, input.description);
    return this.findByHash(input.fileHash)!;
  }
  updatePath(id: number, filePath: string): void { this.db.prepare('UPDATE photos SET file_path=? WHERE id=?').run(filePath, id); }
  updateMetadata(id: number, metadata: { capturedAt: Date | string | null; latitude: number | null; longitude: number | null; locationName?: string | null; exif: Record<string, unknown> | null }): void {
    const capturedAt = metadata.capturedAt instanceof Date ? metadata.capturedAt.toISOString() : metadata.capturedAt;
    this.db.prepare(`UPDATE photos SET captured_at=?,latitude=?,longitude=?,location_name=COALESCE(?,location_name),exif_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(capturedAt, metadata.latitude, metadata.longitude, metadata.locationName ?? null, metadata.exif ? JSON.stringify(metadata.exif) : null, id);
  }
  reclassifyStoryRejected(): number {
    const rows = this.db.prepare("SELECT id,captured_at,latitude,longitude FROM photos WHERE status='rejected' AND error='故事性评分不足'").all() as Row[];
    const update = this.db.prepare("UPDATE photos SET status=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?");
    let changed = 0;
    for (const row of rows) {
      const nextStatus = row.captured_at ? 'pending' : 'needs_metadata';
      update.run(nextStatus, nextStatus === 'pending' ? null : '缺少 EXIF 拍摄时间，不能归入拍摄事件', row.id); changed++;
    }
    return changed;
  }
  reclassifyMetadataStatuses(): number {
    const result = this.db.prepare("UPDATE photos SET status='pending',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE status='needs_metadata' AND captured_at IS NOT NULL AND analysis_attempted_at IS NOT NULL").run();
    return Number(result.changes);
  }
  saveAnalysis(id: number, values: Pick<PhotoRecord, 'metrics' | 'assessment' | 'totalScore' | 'status' | 'error' | 'analysisVersion'> & { outcome?: 'assessed' | 'skipped' | 'failed' | null }): void {
    const outcome = values.outcome === undefined ? values.assessment ? 'assessed' : values.status === 'rejected' && values.metrics ? 'skipped' : values.error ? 'failed' : null : values.outcome;
    this.db.prepare(`UPDATE photos SET metrics_json=?, assessment_json=?, total_score=?, analysis_version=?,analysis_outcome=?,analysis_attempts=COALESCE(analysis_attempts,0)+CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
      status=CASE WHEN status IN ('published','publishing','draft_saved','uncertain','failed') THEN status ELSE ? END,
      error=CASE WHEN status IN ('published','publishing','draft_saved','uncertain','failed') THEN error ELSE ? END,
      analysis_attempted_at=CASE WHEN ? IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND manual_scores_at IS NULL`).run(
      values.metrics ? JSON.stringify(values.metrics) : null, values.assessment ? JSON.stringify(values.assessment) : null,
        values.totalScore, values.analysisVersion, outcome, outcome, values.status, values.error, outcome, id);
  }

  updateManualScores(id: number, input: unknown, revision: number, policy: SelectionPolicy): PhotoRecord {
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError('照片编号无效');
    const parsed = manualScoresSchema.safeParse(input);
    if (!parsed.success) throw new RangeError('请填写全部五项评分，每项必须是 0 到 100 的数字');
    if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('评分版本无效，请重新打开详情');
    const photo = this.getPhoto(id);
    if (!photo) throw new RangeError('照片不存在');
    if (!photo.metrics || !photo.analysisAttemptedAt) throw new RangeError('照片尚未完成扫描，请扫描后再修改评分');
    if (photo.scoreRevision !== revision) throw new RangeError('评分已被修改，请重新打开详情后再保存');
    const { technicalScore, ...scores } = parsed.data;
    const metrics = { ...photo.metrics, technicalScore };
    const assessment = { ...(photo.assessment ?? { summary: '人工评分，尚无模型画面描述', observations: [], theme: '其他' as const, reason: '人工评分，尚无模型评价理由' }), ...scores };
    const score = totalScore(technicalScore, assessment);
    const reason = rejectionReason({ ...photo, metrics, assessment, totalScore: score }, policy);
    const status = reason ? 'rejected' : photo.capturedAt ? 'pending' : 'needs_metadata';
    const error = reason ?? (photo.capturedAt ? null : '缺少 EXIF 拍摄时间，不能归入拍摄事件');
    this.db.prepare(`UPDATE photos SET metrics_json=?,assessment_json=?,total_score=?,analysis_outcome='assessed',
      manual_scores_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),score_revision=score_revision+1,
      status=CASE WHEN status IN ('published','publishing','draft_saved','uncertain','failed') THEN status ELSE ? END,
      error=CASE WHEN status IN ('published','publishing','draft_saved','uncertain','failed') THEN error ELSE ? END,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(metrics), JSON.stringify(assessment), score, status, error, id);
    return this.getPhoto(id)!;
  }

  listEvents(): ShootingEvent[] {
    return (this.db.prepare(`SELECT e.*, COUNT(p.id) used_posts FROM events e LEFT JOIN posts p
      ON (p.event_id=e.id OR EXISTS(SELECT 1 FROM post_photos pp JOIN photos photo ON photo.id=pp.photo_id WHERE pp.post_id=p.id AND photo.event_id=e.id))
      AND p.status IN ('publishing','submitted','draft_saved','published','uncertain') GROUP BY e.id ORDER BY e.start_at,e.id`).all() as Row[])
      .map(r => ({ id: r.id, startAt: r.start_at, endAt: r.end_at,
        latitude: r.location_available === 0 ? null : r.latitude, longitude: r.location_available === 0 ? null : r.longitude,
        locationName: r.location_name, usedPosts: r.used_posts }));
  }

  groupPhotos(gapHours: number, radiusMeters: number): void {
    this.transaction(() => {
      // Persistent anchors avoid grid boundaries and retain quotas after rescans/restarts.
      for (const photo of this.listPhotos().filter(p => p.eventId === null && p.capturedAt)) {
        const timestamp = Date.parse(photo.capturedAt!);
        if (!Number.isFinite(timestamp)) continue;
        const hasLocation = photo.latitude !== null && photo.longitude !== null;
        const point = hasLocation ? { latitude: photo.latitude!, longitude: photo.longitude! } : null;
        const matching = this.listEvents().filter(e => {
          if (timestamp < Date.parse(e.startAt) - gapHours * 3600000 || timestamp > Date.parse(e.endAt) + gapHours * 3600000) return false;
          // A photo without GPS is grouped by time only, while GPS photos retain the distance constraint.
          if (!hasLocation) return e.latitude === null && e.longitude === null;
          return e.latitude !== null && e.longitude !== null && distanceMeters(point!, { latitude: e.latitude, longitude: e.longitude }) <= radiusMeters;
        }).sort((a, b) => a.id - b.id);
        let eventId: number;
        if (!matching.length) {
          eventId = Number(this.db.prepare('INSERT INTO events(start_at,end_at,latitude,longitude,location_name,location_available) VALUES (?,?,?,?,?,?)')
            .run(photo.capturedAt!, photo.capturedAt!, point?.latitude ?? 0, point?.longitude ?? 0, hasLocation ? photo.locationName : null, hasLocation ? 1 : 0).lastInsertRowid);
        } else {
          eventId = matching[0].id;
          const times = matching.flatMap(e => [e.startAt, e.endAt]).concat(photo.capturedAt!).sort();
          for (const event of matching.slice(1)) {
            // Bridging photos merge events AND their already consumed publication slots.
            this.db.prepare('UPDATE photos SET event_id=? WHERE event_id=?').run(eventId, event.id);
            this.db.prepare('UPDATE posts SET event_id=? WHERE event_id=?').run(eventId, event.id);
            this.db.prepare('DELETE FROM events WHERE id=?').run(event.id);
          }
          this.db.prepare('UPDATE events SET start_at=?,end_at=?,location_name=COALESCE(location_name,?) WHERE id=?')
            .run(times[0], times.at(-1)!, hasLocation ? photo.locationName : null, eventId);
        }
        this.db.prepare('UPDATE photos SET event_id=? WHERE id=?').run(eventId, photo.id);
      }
      // Every legacy published/uncertain single-photo note consumes one slot.
      const old = this.db.prepare(`SELECT p.* FROM photos p WHERE p.event_id IS NOT NULL AND p.status IN ('published','uncertain')
        AND NOT EXISTS(SELECT 1 FROM post_photos pp WHERE pp.photo_id=p.id)`).all() as Row[];
      for (const row of old) {
        const postId = Number(this.db.prepare(`INSERT INTO posts(event_id,channel,orientation,theme,title,description,status,remote_url,published_at)
          VALUES (?,'xiaohongshu','legacy','legacy',?,?,?,?,?)`).run(row.event_id, row.title, row.description, row.status, row.remote_url, row.published_at).lastInsertRowid);
        this.db.prepare('INSERT INTO post_photos VALUES(?,?,0)').run(postId, row.id);
      }
    });
  }

  preview(policy: SelectionPolicy): PublishBatch[] {
    return this.listDrafts().map(draft => ({
      ...batchFrom(draft.photoIds.map(id => this.getPhoto(id)!).filter(Boolean), this.listEvents().find(event => event.id === draft.eventId)!),
      theme: draft.theme, title: draft.title, description: draft.description,
      locationName: draft.locationTag ?? '', topics: draft.topics, verifiedTopics: draft.verifiedTopics, locationVerified: draft.locationVerified
    }));
  }

  previewDraft(postId: number, _policy: SelectionPolicy): PublishBatch {
    const draft = this.listDrafts().find(item => item.id === postId);
    if (!draft) throw new Error('草稿不存在或已经处理');
    const event = this.listEvents().find(item => item.id === draft.eventId);
    if (!event) throw new Error('草稿缺少拍摄事件');
    const photos = draft.photoIds.map(id => this.getPhoto(id)).filter((photo): photo is PhotoRecord => Boolean(photo));
    if (photos.length !== draft.photoIds.length) throw new Error('草稿中的照片已不存在');
    const generated = batchFrom(photos, event);
    return { ...generated, theme: draft.theme, title: draft.title, description: draft.description, locationName: draft.locationTag ?? '', topics: draft.topics, verifiedTopics: draft.verifiedTopics, locationVerified: draft.locationVerified };
  }

  ensureDrafts(policy: SelectionPolicy): number {
    return this.transaction(() => {
      // Older versions joined every selected summary into a very long note.
      // Compact generated and manually edited drafts to the current limit.
      const legacyDrafts = this.db.prepare(`SELECT id,description FROM posts WHERE status='draft' AND length(description)>${MAX_DESCRIPTION_LENGTH}`).all() as Row[];
      for (const row of legacyDrafts) {
        const compact = String(row.description ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_LENGTH);
        this.db.prepare('UPDATE posts SET description=? WHERE id=? AND status=\'draft\'').run(compact, row.id);
      }
      const draftRows = this.listDrafts();
      const draftPhotoRows = this.db.prepare("SELECT pp.photo_id FROM post_photos pp JOIN posts p ON p.id=pp.post_id WHERE p.status='draft'").all() as Row[];
      const draftPhotoIds = new Set(draftPhotoRows.map(row => Number(row.photo_id)));
      const draftCounts = new Map<number, number>();
      for (const row of draftRows) for (const eventId of row.eventIds) draftCounts.set(eventId, (draftCounts.get(eventId) ?? 0) + 1);
      const events = this.listEvents().map(event => ({ ...event, usedPosts: event.usedPosts + (draftCounts.get(event.id) ?? 0) }));
      const allPhotos = this.listPhotos();
      const heldPhotos = allPhotos.filter(photo => draftPhotoIds.has(photo.id));
      const available = allPhotos.filter(photo => !draftPhotoIds.has(photo.id) && !heldPhotos.some(held => isDuplicate(photo, held, policy.duplicateDistance)));
      const batches = planBatches(available, events, policy);
      for (const batch of batches) {
        const postId = Number(this.db.prepare(`INSERT INTO posts(event_id,channel,orientation,theme,title,description,status,scheduled_at,location_tag,topics_json)
          VALUES (?,'xiaohongshu',?,?,?,?,'draft',NULL,?,?)`).run(
            batch.eventId, batch.orientation, batch.theme, batch.title, batch.description,
            batch.locationName || null, JSON.stringify(batch.topics ?? [])
          ).lastInsertRowid);
        batch.photos.forEach((photo, position) => this.db.prepare('INSERT INTO post_photos VALUES(?,?,?)').run(postId, photo.id, position));
      }
      return batches.length;
    });
  }

  private postById(postId: number): PostRecord | null {
    return this.listPosts().find(post => post.id === postId) ?? null;
  }

  private validateDraftPhotos(photos: PhotoRecord[], policy: SelectionPolicy, merged: boolean): ShootingEvent {
    const events = this.listEvents();
    const event = events.find(item => item.id === photos[0]?.eventId);
    if (!event) throw new Error('草稿缺少拍摄事件');
    for (const eventId of new Set(photos.map(photo => photo.eventId))) {
      const sourceEvent = events.find(item => item.id === eventId);
      if (!sourceEvent) throw new Error('照片缺少拍摄事件');
      if (sourceEvent.usedPosts >= 3) throw new Error('同一拍摄事件已使用三次发布配额');
    }
    validateSelection(photos, this.listPhotos(), event, policy, { allowMixedEvents: merged, allowMixedThemes: merged });
    return event;
  }

  mergeDrafts(sources: { id: number; revision: number }[], photoIds: number[], policy: SelectionPolicy,
    fields: { title?: string; description?: string; scheduledAt?: string | null } = {}): PostRecord {
    return this.transaction(() => {
      if (!Array.isArray(sources) || sources.length < 2 || sources.length > 100 || sources.some(source => !Number.isSafeInteger(source.id) || source.id < 1 || !Number.isSafeInteger(source.revision) || source.revision < 0)) throw new Error('请选择 2 到 100 篇待发布草稿');
      const ids = sources.map(source => source.id);
      if (new Set(ids).size !== ids.length) throw new Error('同一草稿不能重复选择');
      const allDrafts = this.listDrafts();
      const drafts = sources.map(source => {
        const draft = allDrafts.find(item => item.id === source.id);
        if (!draft) throw new Error('所选草稿已被处理，请刷新后重新选择');
        if (draft.revision !== source.revision) throw new Error('所选草稿已被修改，请刷新后重新选择');
        return draft;
      });
      if (!Array.isArray(photoIds) || !photoIds.length || photoIds.length > policy.maxImages) throw new Error(`合并后须选择 1 到 ${policy.maxImages} 张照片`);
      if (photoIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(photoIds).size !== photoIds.length) throw new Error('照片编号无效或重复');
      const availableIds = new Set(drafts.flatMap(draft => draft.photoIds));
      const photos = photoIds.map(id => {
        if (!availableIds.has(id)) throw new Error('只能选择所选草稿中的照片');
        const photo = this.getPhoto(id);
        if (!photo) throw new Error(`照片 ${id} 不存在`);
        return photo;
      });
      const event = this.validateDraftPhotos(photos, policy, true);
      const otherPhotos = allDrafts.filter(draft => !ids.includes(draft.id)).flatMap(draft => draft.photoIds).map(id => this.getPhoto(id)!).filter(Boolean);
      if (photos.some(photo => otherPhotos.some(other => isDuplicate(photo, other, policy.duplicateDistance)))) throw new Error('照片与其他待发布草稿重复或近似');
      const first = drafts[0];
      let scheduledAt = fields.scheduledAt === undefined ? first.scheduledAt : fields.scheduledAt;
      if (scheduledAt) {
        const parsed = new Date(scheduledAt);
        if (!Number.isFinite(parsed.getTime())) throw new Error('发布时间格式无效');
        scheduledAt = parsed.toISOString();
      } else scheduledAt = null;
      const title = (fields.title ?? first.title).trim().slice(0, 20);
      const description = (fields.description ?? first.description).trim().slice(0, MAX_DESCRIPTION_LENGTH);
      const locationTag = drafts.every(draft => draft.locationTag === first.locationTag) ? first.locationTag : null;
      const locationVerified = Boolean(locationTag) && drafts.every(draft => draft.locationVerified);
      const theme = new Set(photos.map(photo => photo.assessment!.theme)).size > 1 ? '综合' : photos[0].assessment!.theme;
      for (const draft of drafts) this.db.prepare('DELETE FROM post_photos WHERE post_id=?').run(draft.id);
      for (const draft of drafts.slice(1)) this.db.prepare('DELETE FROM posts WHERE id=?').run(draft.id);
      photos.forEach((photo, index) => this.db.prepare('INSERT INTO post_photos VALUES(?,?,?)').run(first.id, photo.id, index));
      this.db.prepare('UPDATE posts SET event_id=?,orientation=?,theme=?,title=?,description=?,scheduled_at=?,location_tag=?,location_verified=?,merged=1,revision=revision+1 WHERE id=?')
        .run(event.id, photos[0].metrics!.orientation, theme, title, description, scheduledAt, locationTag, locationVerified ? 1 : 0, first.id);
      return this.postById(first.id)!;
    });
  }

  listDrafts(): PostRecord[] { return this.listPosts().filter(post => post.status === 'draft').sort((a,b) => a.id - b.id); }
  scheduleDrafts(times: string[], force = false): void {
    const drafts = this.listDrafts().filter(draft => force || !draft.scheduledAt);
    drafts.forEach((draft, index) => {
      this.db.prepare("UPDATE posts SET scheduled_at=?,revision=revision+1 WHERE id=? AND status='draft'").run(times[index] ?? null, draft.id);
    });
  }

  updateDraft(
    postId: number,
    photoIds: number[],
    policy: SelectionPolicy,
    titleOrFields?: string | { title?: string; description?: string; scheduledAt?: string | null; locationTag?: string | null; topics?: string[]; verifiedTopics?: string[]; locationVerified?: boolean },
    legacyDescription?: string
  ): PostRecord {
    return this.transaction(() => {
      const draft = this.postById(postId);
      if (!draft || draft.status !== 'draft') throw new Error('只有待发布草稿可以修改');
      if (!photoIds.length || photoIds.length > policy.maxImages) throw new Error(`每篇草稿须选择 1 到 ${policy.maxImages} 张照片`);
      if (new Set(photoIds).size !== photoIds.length) throw new Error('同一照片不能重复选择');
      const currentIds = new Set(draft.photoIds);
      const otherDraftRows = this.db.prepare("SELECT pp.photo_id FROM post_photos pp JOIN posts p ON p.id=pp.post_id WHERE p.status='draft' AND p.id<>?").all(postId) as Row[];
      const otherDraftIds = new Set(otherDraftRows.map(row => Number(row.photo_id)));
      if (photoIds.some(id => otherDraftIds.has(id))) throw new Error('照片已经被其他待发布草稿占用');
      const otherDraftPhotos = [...otherDraftIds].map(id => this.getPhoto(id)!).filter(Boolean);
      const photos = photoIds.map(id => {
        const photo = this.getPhoto(id);
        if (!photo) throw new Error(`照片 ${id} 不存在`);
        if (photo.status !== 'pending' && !currentIds.has(id)) throw new Error(`照片 ${id} 当前状态为 ${photo.status}，不能加入草稿`);
        return photo;
      });
      const event = this.validateDraftPhotos(photos, policy, draft.merged);
      if (photos.some(photo => otherDraftPhotos.some(other => isDuplicate(photo, other, policy.duplicateDistance)))) throw new Error('照片与其他待发布草稿重复或近似');
      const generated = batchFrom(photos, event);
      const fields = typeof titleOrFields === 'string'
        ? { title: titleOrFields, description: legacyDescription }
        : (titleOrFields ?? {});
      const nextTitle = typeof fields.title === 'string' ? fields.title.trim().slice(0, 20) : draft.title;
      const nextDescription = typeof fields.description === 'string' ? fields.description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : draft.description.slice(0, MAX_DESCRIPTION_LENGTH);
      let nextScheduledAt = draft.scheduledAt;
      if (fields.scheduledAt !== undefined) {
        if (fields.scheduledAt === null || fields.scheduledAt.trim() === '') nextScheduledAt = null;
        else {
          const parsed = new Date(fields.scheduledAt);
          if (!Number.isFinite(parsed.getTime())) throw new Error('发布时间格式无效');
          nextScheduledAt = parsed.toISOString();
        }
      }
      const nextLocationTag = fields.locationTag === undefined
        ? draft.locationTag
        : (typeof fields.locationTag === 'string' && fields.locationTag.trim() ? fields.locationTag.trim().slice(0, 100) : null);
      const nextTopics = fields.topics === undefined ? draft.topics : normalizeTopics(fields.topics);
      const nextVerifiedTopics = fields.topics === undefined
        ? draft.verifiedTopics
        : normalizeTopics(fields.verifiedTopics).filter(topic => nextTopics.includes(topic));
      const nextLocationVerified = fields.locationTag === undefined
        ? draft.locationVerified
        : Boolean(fields.locationVerified) && Boolean(nextLocationTag);
      this.db.prepare('DELETE FROM post_photos WHERE post_id=?').run(postId);
      photos.forEach((photo, position) => this.db.prepare('INSERT INTO post_photos VALUES(?,?,?)').run(postId, photo.id, position));
      const theme = draft.merged && new Set(photos.map(photo => photo.assessment!.theme)).size > 1 ? '综合' : generated.theme;
      this.db.prepare('UPDATE posts SET event_id=?,orientation=?,theme=?,title=?,description=?,scheduled_at=?,location_tag=?,topics_json=?,verified_topics_json=?,location_verified=?,revision=revision+1 WHERE id=?')
        .run(event.id, generated.orientation, theme, nextTitle, nextDescription, nextScheduledAt, nextLocationTag, JSON.stringify(nextTopics), JSON.stringify(nextVerifiedTopics), nextLocationVerified ? 1 : 0, postId);
      return this.postById(postId)!;
    });
  }

  markDraftMetadataVerified(postId: number, verifiedTopics: string[], locationVerified: boolean): void {
    this.db.prepare("UPDATE posts SET verified_topics_json=?, location_verified=?,revision=revision+1 WHERE id=? AND status='draft'")
      .run(JSON.stringify(normalizeTopics(verifiedTopics)), locationVerified ? 1 : 0, postId);
  }

  deleteDraft(postId: number): void {
    this.transaction(() => {
      const draft = this.postById(postId);
      if (!draft || draft.status !== 'draft') throw new Error('只有待发布草稿可以删除');
      this.db.prepare('DELETE FROM post_photos WHERE post_id=?').run(postId);
      this.db.prepare('DELETE FROM posts WHERE id=?').run(postId);
    });
  }

  reserveDraft(postId: number, policy: SelectionPolicy): { postId: number; batch: PublishBatch } {
    return this.transaction(() => {
      const draft = this.postById(postId);
      if (!draft || draft.status !== 'draft') throw new Error('草稿不存在或已经处理');
      const photos = draft.photoIds.map(id => this.getPhoto(id)).filter((photo): photo is PhotoRecord => Boolean(photo));
      if (photos.length !== draft.photoIds.length) throw new Error('草稿中的照片已不存在');
      const event = this.validateDraftPhotos(photos, policy, draft.merged);
      const generated = batchFrom(photos, event);
      const batch = {
        ...generated,
        theme: draft.theme,
        title: draft.title,
        description: draft.description,
        locationName: draft.locationTag ?? '',
        topics: draft.topics,
        verifiedTopics: draft.verifiedTopics,
        locationVerified: draft.locationVerified
      };
      this.db.prepare("UPDATE posts SET status='publishing',error=NULL,revision=revision+1 WHERE id=? AND status='draft'").run(postId);
      photos.forEach(photo => this.db.prepare("UPDATE photos SET status='publishing',error=NULL WHERE id=?").run(photo.id));
      return { postId, batch };
    });
  }

  reserve(photoIds: number[], policy: SelectionPolicy): { postId: number; batch: PublishBatch } {
    return this.transaction(() => {
      if (new Set(photoIds).size !== photoIds.length) throw new Error('同一照片不能在一篇笔记中重复出现');
      const photos = photoIds.map(id => { const p = this.getPhoto(id); if (!p) throw new Error(`照片 ${id} 不存在`); return p; });
      const event = this.listEvents().find(e => e.id === photos[0]?.eventId);
      if (!event) throw new Error('照片缺少拍摄时间/GPS，无法核验发布配额');
      validateSelection(photos, this.listPhotos(), event, policy);
      const batch = batchFrom(photos, event);
      const postId = Number(this.db.prepare(`INSERT INTO posts(event_id,channel,orientation,theme,title,description,status) VALUES (?,'xiaohongshu',?,?,?,?,'publishing')`)
        .run(event.id, batch.orientation, batch.theme, batch.title, batch.description).lastInsertRowid);
      photos.forEach((p, i) => {
        this.db.prepare('INSERT INTO post_photos VALUES(?,?,?)').run(postId, p.id, i);
        this.db.prepare("UPDATE photos SET status='publishing',error=NULL WHERE id=?").run(p.id);
      });
      return { postId, batch };
    });
  }

  markSubmitted(postId: number): void {
    this.db.prepare("UPDATE posts SET status='submitted' WHERE id=? AND status='publishing'").run(postId);
  }
  finishPost(postId: number, status: 'published' | 'draft_saved' | 'uncertain' | 'failed', remoteUrl: string | null, error: string | null): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      const publishedAt = status === 'published' ? now : null;
      const draftSavedAt = status === 'draft_saved' ? now : null;
      this.db.prepare('UPDATE posts SET status=?,remote_url=?,error=?,published_at=?,draft_saved_at=?,revision=revision+1 WHERE id=?').run(status, remoteUrl, error, publishedAt, draftSavedAt, postId);
      this.db.prepare(`UPDATE photos SET status=?,remote_url=?,error=?,published_at=?,updated_at=CURRENT_TIMESTAMP
        WHERE id IN (SELECT photo_id FROM post_photos WHERE post_id=?)`).run(status, remoteUrl, error, now, postId);
      if (status !== 'published') this.db.prepare("UPDATE photos SET published_at=NULL WHERE id IN (SELECT photo_id FROM post_photos WHERE post_id=?)").run(postId);
    });
  }
  recordDraftSaveError(postId: number, error: string): void {
    this.db.prepare("UPDATE posts SET error=?,revision=revision+1 WHERE id=? AND status='draft'").run(error.slice(0, 2000), postId);
  }
  confirmHandoff(postId: number, revision: number, result: 'draft_saved' | 'published', policy: SelectionPolicy): PostRecord {
    return this.transaction(() => {
      const post = this.postById(postId);
      if (!post) throw new Error('笔记不存在');
      // Retried HTTP requests must not create another record or change its time.
      if (post.revision === revision + 1 && post.status === result && post.manualConfirmedAt) return post;
      if (post.revision !== revision) throw new Error('笔记内容或状态已变化，请重新打开准备发布窗口');
      if (post.status !== 'draft' && !(post.status === 'draft_saved' && (result === 'published' || !post.manualConfirmedAt))) throw new Error('当前笔记状态不能确认此结果');
      const photos = post.photoIds.map(id => this.getPhoto(id)).filter((photo): photo is PhotoRecord => Boolean(photo));
      if (photos.length !== post.photoIds.length || !photos.length) throw new Error('笔记中的照片已不存在');
      if (post.status === 'draft') this.validateDraftPhotos(photos, policy, post.merged);
      // A saved draft has already consumed its event slot. Publishing it consumes no extra slot.
      const now = new Date().toISOString();
      const publishedAt = result === 'published' ? now : null;
      const savedAt = result === 'draft_saved' ? now : post.draftSavedAt;
      this.db.prepare(`UPDATE posts SET status=?,published_at=?,draft_saved_at=?,manual_confirmed_at=?,
        error=NULL,revision=revision+1 WHERE id=?`).run(result, publishedAt, savedAt, now, postId);
      this.db.prepare(`UPDATE photos SET status=?,published_at=?,error=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE id IN (SELECT photo_id FROM post_photos WHERE post_id=?)`).run(result, publishedAt, postId);
      return this.postById(postId)!;
    });
  }
  recordXhsDraftEvidence(postId: number, evidence: { draftId: string; account: string | null }): void {
    if (!evidence.draftId.trim()) throw new Error('缺少小红书本地草稿编号');
    this.db.prepare('UPDATE posts SET xhs_draft_id=?,xhs_draft_account=? WHERE id=?').run(evidence.draftId, evidence.account, postId);
  }
  releasePostToDraft(postId: number, error: string | null = null): void {
    this.transaction(() => {
      this.db.prepare("UPDATE posts SET status='draft',remote_url=NULL,error=?,published_at=NULL,draft_saved_at=NULL,verified_topics_json='[]',location_verified=0,revision=revision+1 WHERE id=? AND status IN ('publishing','submitted','draft_saved','uncertain','failed')").run(error?.slice(0, 2000) ?? null, postId);
      this.db.prepare('UPDATE posts SET xhs_draft_id=NULL,xhs_draft_account=NULL,manual_confirmed_at=NULL WHERE id=? AND status=\'draft\'').run(postId);
      this.db.prepare(`UPDATE photos SET status='pending',remote_url=NULL,error=NULL,published_at=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE id IN (SELECT photo_id FROM post_photos WHERE post_id=?) AND status IN ('publishing','submitted','draft_saved','uncertain','failed')`).run(postId);
    });
  }
  private recoverPrePublishFailures(): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT id,error FROM posts WHERE status='uncertain'").all() as Row[];
      for (const row of rows) {
        if (!isPrePublishFailure(row.error ?? null)) continue;
      this.db.prepare("UPDATE posts SET status='draft',remote_url=NULL,error=NULL,published_at=NULL,draft_saved_at=NULL,verified_topics_json='[]',location_verified=0 WHERE id=?").run(row.id);
        this.db.prepare(`UPDATE photos SET status='pending',remote_url=NULL,error=NULL,published_at=NULL,updated_at=CURRENT_TIMESTAMP
          WHERE id IN (SELECT photo_id FROM post_photos WHERE post_id=?) AND status IN ('uncertain','failed','publishing')`).run(row.id);
      }
    });
  }
  recoverInterrupted(): void {
    this.transaction(() => {
      this.db.exec(`UPDATE posts SET status='uncertain', error='进程中断，保存草稿结果待人工核验' WHERE status IN ('publishing','submitted');
        UPDATE photos SET status='uncertain',error='进程中断，保存草稿结果待人工核验' WHERE status='publishing';`);
    });
  }
  listPosts(): PostRecord[] {
    return (this.db.prepare(`SELECT p.*, e.location_name,
      (SELECT json_group_array(DISTINCT photo.event_id) FROM post_photos pp JOIN photos photo ON photo.id=pp.photo_id WHERE pp.post_id=p.id AND photo.event_id IS NOT NULL) event_ids_json
      FROM posts p LEFT JOIN events e ON e.id=p.event_id ORDER BY p.id DESC`).all() as Row[]).map(r => {
      const linkedEventIds = JSON.parse(r.event_ids_json) as number[];
      return {
      id: r.id, eventId: r.event_id, status: r.status as PostStatus, channel: r.channel ?? 'xiaohongshu',
      eventIds: linkedEventIds.length ? linkedEventIds : [r.event_id], merged: Boolean(r.merged), revision: Number(r.revision ?? 0),
      orientation: r.orientation, theme: r.theme, locationName: r.merged && linkedEventIds.length > 1 ? null : r.location_name ?? null,
      locationTag: r.merged ? r.location_tag ?? null : r.location_tag ?? r.location_name ?? null,
      topics: (() => { try { const value = r.topics_json ? JSON.parse(r.topics_json) : []; return Array.isArray(value) ? value.map(String) : []; } catch { return []; } })(),
      verifiedTopics: (() => { try { const value = r.verified_topics_json ? JSON.parse(r.verified_topics_json) : []; return Array.isArray(value) ? value.map(String) : []; } catch { return []; } })(),
      locationVerified: Boolean(r.location_verified),
      xhsDraftId: r.xhs_draft_id ?? null, xhsDraftAccount: r.xhs_draft_account ?? null,
      xhsDraftStorage: r.status === 'draft_saved' ? r.manual_confirmed_at ? 'user_browser_local' : 'browser_local' : null,
      manualConfirmedAt: r.manual_confirmed_at ?? null,
      createdAt: r.created_at, scheduledAt: r.scheduled_at ?? null, draftSavedAt: r.draft_saved_at ?? null, publishedAt: r.published_at, title: r.title, description: r.description, remoteUrl: r.remote_url, error: r.error,
      photoIds: (this.db.prepare('SELECT photo_id FROM post_photos WHERE post_id=? ORDER BY position').all(r.id) as Row[]).map(p => p.photo_id)
      };
    });
  }
  resolvePost(postId: number, published: boolean, remoteUrl: string | null): void {
    const post = this.listPosts().find(p => p.id === postId);
    if (!post || !['draft_saved', 'uncertain', 'failed'].includes(post.status)) throw new Error('只有小红书草稿、待确认或失败的笔记可以人工处理');
    if (published) { this.finishPost(postId, 'published', remoteUrl, null); return; }
    if (post.status === 'draft_saved') { this.releasePostToDraft(postId); return; }
    this.transaction(() => {
      this.db.prepare("UPDATE posts SET status='failed',error='人工核实未发布' WHERE id=?").run(postId);
      this.db.prepare(`UPDATE photos SET status='pending',error=NULL WHERE id IN
        (SELECT photo_id FROM post_photos WHERE post_id=?) AND status IN ('uncertain','failed')`).run(postId);
    });
  }
  counts(): Record<PhotoStatus, number> {
    const result: Record<PhotoStatus, number> = { pending: 0, needs_analysis: 0, needs_metadata: 0, rejected: 0, publishing: 0, draft_saved: 0, published: 0, uncertain: 0, failed: 0, skipped: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) count FROM photos GROUP BY status').all() as Row[]) result[row.status as PhotoStatus] = row.count;
    return result;
  }
  close(): void { this.db.close(); }
}
