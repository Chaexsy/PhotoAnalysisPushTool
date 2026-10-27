import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { PhotoStore } from './db.js';
import type { PhotoLibraryQuery } from './types.js';

const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

export async function* imageFiles(root: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) yield* imageFiles(filePath);
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) yield filePath;
  }
}

const querySchema = z.object({
  directory: z.string().max(2000).optional(), location: z.string().max(200).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasLocation: z.enum(['all', 'yes', 'no']).default('all'),
  scan: z.enum(['all', 'scanned', 'unscanned', 'failed']).default('all'),
  evaluated: z.enum(['all', 'unassessed', 'assessed', 'failed', 'skipped']).default('all'),
  rated: z.enum(['all', 'rated', 'unrated', 'lt65', '65to75', '75to85', 'gt85']).default('all'),
  timeField: z.enum(['captured', 'modified', 'analyzed']).default('captured'),
  sort: z.enum(['newest', 'oldest', 'score']).default('newest'),
  limit: z.coerce.number().int().min(1).max(120).default(48),
  offset: z.coerce.number().int().min(0).max(10000000).default(0)
});

export function parseLibraryQuery(value: unknown): PhotoLibraryQuery {
  const query = querySchema.parse(value);
  // The process time zone is the configured NAS time zone. Date ranges use local calendar days.
  const dateStart = (value: string) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('日期不存在');
    return date;
  };
  const fromMs = query.from ? dateStart(query.from).getTime() : undefined;
  const toDate = query.to ? dateStart(query.to) : null;
  if (toDate) toDate.setDate(toDate.getDate() + 1);
  const toMs = toDate?.getTime();
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) throw new Error('起始日期不能晚于结束日期');
  return { ...query, fromMs, toMs };
}

export class PhotoLibrary {
  private lastIndexedAt = 0;
  private indexing: Promise<void> | null = null;
  private thumbnails = new Map<string, Buffer>();
  constructor(private store: PhotoStore, private root: string) {}

  async ensureIndex(force = false): Promise<void> {
    if (this.indexing) return this.indexing;
    if (!force && Date.now() - this.lastIndexedAt < 60000) return;
    this.indexing = (async () => {
      const files: { filePath: string; size: number; mtimeMs: number }[] = [];
      for await (const filePath of imageFiles(this.root)) {
        const stat = await fs.stat(filePath);
        files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      // Publish one complete inventory, retaining the previous inventory if any directory is inaccessible.
      this.store.replaceLibraryFiles(files);
      this.lastIndexedAt = Date.now();
    })().finally(() => { this.indexing = null; });
    return this.indexing;
  }

  async search(query: PhotoLibraryQuery) {
    await this.ensureIndex();
    return { ...this.store.searchPhotoLibrary(query), limit: query.limit, offset: query.offset, indexedAt: new Date(this.lastIndexedAt).toISOString() };
  }

  async detail(fileId: number) {
    await this.ensureIndex();
    return this.store.searchPhotoLibrary({ fileId, limit: 1, offset: 0 }).photos[0] ?? null;
  }

  async resolveFile(id: number): Promise<string> {
    const file = this.store.libraryFile(id);
    if (!file) throw new Error('照片不存在，请刷新照片库');
    const resolved = await fs.realpath(file.filePath);
    const root = await fs.realpath(this.root);
    const relative = path.relative(root, resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('照片不在指定目录内');
    return resolved;
  }

  async thumbnail(id: number, width: number): Promise<Buffer> {
    const filePath = await this.resolveFile(id);
    const stat = await fs.stat(filePath);
    const key = `${id}:${stat.size}:${stat.mtimeMs}:${width}`;
    const cached = this.thumbnails.get(key);
    if (cached) { this.thumbnails.delete(key); this.thumbnails.set(key, cached); return cached; }
    const buffer = await sharp(filePath, { failOn: 'error', limitInputPixels: 100000000 }).rotate()
      .resize(width, width, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: width > 640 ? 85 : 75 }).toBuffer();
    this.thumbnails.set(key, buffer);
    while (this.thumbnails.size > 96) this.thumbnails.delete(this.thumbnails.keys().next().value!);
    return buffer;
  }
}
