export type Orientation = 'landscape' | 'portrait' | 'square';
export type PhotoStatus = 'pending' | 'needs_analysis' | 'needs_metadata' | 'rejected' | 'publishing' | 'draft_saved' | 'published' | 'uncertain' | 'failed' | 'skipped';
export type PostStatus = 'draft' | 'publishing' | 'submitted' | 'draft_saved' | 'published' | 'uncertain' | 'failed';
export const storyThemes = ['自然风景', '城市街景', '人物活动', '动物观察', '生活片段', '建筑空间', '其他'] as const;

export interface VisionAssessment {
  quality: number;
  composition: number;
  story: number;
  aesthetics: number;
  summary: string;
  observations: string[];
  theme: typeof storyThemes[number];
  reason: string;
}

export interface ImageMetrics {
  width: number;
  height: number;
  orientation: Orientation;
  visualHash: string;
  perceptualHash: string;
  technicalScore: number;
  brightness: number;
  sharpness: number;
  darkFraction: number;
  lightFraction: number;
}

export interface PhotoRecord {
  id: number;
  filePath: string;
  fileHash: string;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  locationName: string | null;
  title: string;
  description: string;
  status: PhotoStatus;
  publishedAt: string | null;
  remoteUrl: string | null;
  error: string | null;
  eventId: number | null;
  analysisAttemptedAt: string | null;
  analysisAttempts: number;
  analysisOutcome: 'assessed' | 'skipped' | 'failed' | null;
  metrics: ImageMetrics | null;
  assessment: VisionAssessment | null;
  totalScore: number | null;
  analysisVersion: string | null;
  manualScoresAt?: string | null;
  scoreRevision?: number;
  exif?: Record<string, unknown> | null;
}

export interface PhotoMetadata {
  capturedAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  exif: Record<string, unknown> | null;
}

export type PhotoLibraryScanState = 'unscanned' | 'scanned' | 'failed';
export type PhotoLibraryEvaluationState = 'unassessed' | 'assessed' | 'failed' | 'skipped';

export interface PhotoLibraryItem {
  fileId: number;
  photoId: number | null;
  filePath: string;
  directory: string;
  fileName: string;
  modifiedAt: string;
  size: number;
  discoveredAt: string;
  scanState: PhotoLibraryScanState;
  evaluationState: PhotoLibraryEvaluationState;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  locationName: string | null;
  status: PhotoStatus | 'not_imported';
  error: string | null;
  analysisAttemptedAt: string | null;
  metrics: ImageMetrics | null;
  assessment: VisionAssessment | null;
  totalScore: number | null;
  analysisVersion: string | null;
  manualScoresAt?: string | null;
  scoreRevision?: number;
  exif: Record<string, unknown> | null;
}

export interface PhotoLibraryQuery {
  fileId?: number;
  directory?: string;
  from?: string;
  to?: string;
  location?: string;
  hasLocation?: 'all' | 'yes' | 'no';
  scan?: 'all' | PhotoLibraryScanState;
  evaluated?: 'all' | PhotoLibraryEvaluationState;
  rated?: 'all' | 'rated' | 'unrated' | 'lt65' | '65to75' | '75to85' | 'gt85';
  timeField?: 'captured' | 'modified' | 'analyzed';
  fromMs?: number;
  toMs?: number;
  sort?: 'newest' | 'oldest' | 'score';
  limit: number;
  offset: number;
}

export interface ShootingEvent {
  id: number;
  startAt: string;
  endAt: string;
  latitude: number | null;
  longitude: number | null;
  locationName: string | null;
  usedPosts: number;
}

export interface PublishBatch {
  eventId: number;
  orientation: 'landscape' | 'portrait';
  theme: string;
  photos: PhotoRecord[];
  title: string;
  description: string;
  locationName: string;
  topics?: string[];
  verifiedTopics?: string[];
  locationVerified?: boolean;
}

export interface PostRecord {
  id: number;
  eventId: number;
  eventIds: number[];
  merged: boolean;
  revision: number;
  photoIds: number[];
  status: PostStatus;
  channel: string;
  orientation: 'landscape' | 'portrait' | 'square' | 'legacy';
  theme: string;
  locationName: string | null;
  locationTag: string | null;
  topics: string[];
  verifiedTopics: string[];
  locationVerified: boolean;
  createdAt: string;
  scheduledAt: string | null;
  draftSavedAt: string | null;
  xhsDraftId?: string | null;
  xhsDraftAccount?: string | null;
  xhsDraftStorage?: 'browser_local' | 'user_browser_local' | null;
  manualConfirmedAt?: string | null;
  publishedAt: string | null;
  title: string;
  description: string;
  remoteUrl: string | null;
  error: string | null;
}
