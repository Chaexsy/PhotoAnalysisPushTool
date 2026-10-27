import type { ImageMetrics, PhotoRecord, PublishBatch, ShootingEvent } from './types.js';
import { MAX_DESCRIPTION_LENGTH } from './constants.js';

export interface SelectionPolicy {
  minQuality: number; minAesthetics: number; minStory: number; minComposition: number; minTotal: number;
  minTechnical: number; minShortEdge: number; maxImages: number; duplicateDistance: number;
}

export function orientationOf(width: number, height: number): ImageMetrics['orientation'] {
  if (Math.abs(width / height - 1) <= 0.03) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (n: number) => n * Math.PI / 180;
  const lat = rad(b.latitude - a.latitude), lon = rad(b.longitude - a.longitude);
  const h = Math.sin(lat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(lon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function hashDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), count = 0;
  while (bits) { bits &= bits - 1n; count++; }
  return count;
}

export function isDuplicate(a: PhotoRecord, b: PhotoRecord, threshold: number): boolean {
  if (a.fileHash === b.fileHash) return true;
  if (!a.metrics || !b.metrics) return false;
  if (a.metrics.visualHash === b.metrics.visualHash) return true;
  const aspectA = a.metrics.width / a.metrics.height, aspectB = b.metrics.width / b.metrics.height;
  return Math.abs(aspectA / aspectB - 1) < 0.03 && hashDistance(a.metrics.perceptualHash, b.metrics.perceptualHash) <= threshold;
}

export function rejectionReason(photo: PhotoRecord, policy: SelectionPolicy): string | null {
  const m = photo.metrics, a = photo.assessment;
  if (!m) return '没有可用的图像分析';
  if (Math.min(m.width, m.height) < policy.minShortEdge) return '照片分辨率不足';
  if (m.technicalScore < policy.minTechnical) return '清晰度或曝光未通过本地筛选';
  if (m.orientation === 'square') return '接近正方形，不能归入横图或竖图批次';
  if (!a) return '等待视觉模型分析';
  if (!Number.isFinite(a.aesthetics)) return '等待重新进行美学分析';
  if (a.quality < policy.minQuality) return '视觉质量评分不足';
  if (a.aesthetics < policy.minAesthetics) return '美学价值评分不足';
  if (a.composition < policy.minComposition) return '构图评分不足';
  if ((photo.totalScore ?? 0) < policy.minTotal) return '综合评分不足';
  return null;
}

export function batchFrom(photos: PhotoRecord[], event: ShootingEvent): PublishBatch {
  const first = photos[0], theme = first.assessment!.theme;
  const locationName = event.locationName ?? first.locationName ?? (event.latitude !== null && event.longitude !== null ? `GPS ${event.latitude.toFixed(4)}, ${event.longitude.toFixed(4)}` : '');
  const place = locationName ? locationName.split(' · ').slice(-2).join(' · ') : '未记录地点';
  const summaries = [...new Set(photos.map(p => p.assessment!.summary))].join(' · ').replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION_LENGTH);
  return {
    eventId: event.id, orientation: first.metrics!.orientation as 'landscape' | 'portrait', theme, photos,
    locationName, title: `${place}｜${theme}`.slice(0, 20),
    description: summaries,
    topics: []
  };
}

const reservedStatuses = new Set(['published', 'publishing', 'draft_saved', 'uncertain']);

export function planBatches(photos: PhotoRecord[], events: ShootingEvent[], policy: SelectionPolicy): PublishBatch[] {
  const blocked = photos.filter(p => reservedStatuses.has(p.status));
  const selected: PhotoRecord[] = [], result: PublishBatch[] = [];
  for (const event of events) {
    let remaining = Math.max(0, 3 - event.usedPosts);
    const candidates = photos.filter(p => p.eventId === event.id && p.status === 'pending' && !rejectionReason(p, policy))
      .sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0) || a.id - b.id);
    const buckets = new Map<string, PhotoRecord[]>();
    for (const photo of candidates) {
      if ([...blocked, ...selected].some(p => isDuplicate(photo, p, policy.duplicateDistance))) continue;
      const key = `${photo.metrics!.orientation}:${photo.assessment!.theme}`;
      const bucket = buckets.get(key) ?? [];
      if (bucket.some(p => isDuplicate(photo, p, policy.duplicateDistance))) continue;
      bucket.push(photo); buckets.set(key, bucket);
    }
    const groups = [...buckets.values()].sort((a, b) => b[0].totalScore! - a[0].totalScore!);
    while (remaining > 0 && groups.some(g => g.length)) {
      for (const group of groups) {
        if (remaining === 0) break;
        const eligible = group.filter(p => !selected.some(s => isDuplicate(p, s, policy.duplicateDistance)));
        group.splice(0, group.length, ...eligible);
        if (!group.length) continue;
        const chosen = group.splice(0, policy.maxImages);
        selected.push(...chosen); result.push(batchFrom(chosen, event)); remaining--;
      }
    }
  }
  return result.sort((a, b) => b.photos[0].totalScore! - a.photos[0].totalScore!);
}

export function validateSelection(photos: PhotoRecord[], allPhotos: PhotoRecord[], event: ShootingEvent, policy: SelectionPolicy, options: { allowMixedEvents?: boolean; allowMixedThemes?: boolean } = {}): void {
  if (!photos.length || photos.length > policy.maxImages) throw new Error(`每篇笔记须有 1 到 ${policy.maxImages} 张照片`);
  if (event.usedPosts >= 3) throw new Error('同一拍摄事件已使用三次发布配额');
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    if (photo.status !== 'pending') throw new Error(`照片 ${photo.id} 状态为 ${photo.status}，不能重复发布`);
    if (!options.allowMixedEvents && photo.eventId !== event.id) throw new Error('每篇笔记必须属于同一拍摄事件');
    const reason = rejectionReason(photo, policy);
    if (reason) throw new Error(`照片 ${photo.id}：${reason}`);
    if (photo.metrics!.orientation !== photos[0].metrics!.orientation) throw new Error('横图和竖图不能混发');
    if (!options.allowMixedThemes && photo.assessment!.theme !== photos[0].assessment!.theme) throw new Error('同一篇笔记的主题必须一致');
    if (allPhotos.filter(p => reservedStatuses.has(p.status)).concat(photos.slice(0, i)).some(p => isDuplicate(photo, p, policy.duplicateDistance))) {
      throw new Error(`照片 ${photo.id} 与已发布、待确认或本批次照片重复或近似`);
    }
  }
}
