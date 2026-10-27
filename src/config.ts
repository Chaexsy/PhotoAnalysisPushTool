import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { localDate } from './timing.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  TZ: z.string().default('Asia/Shanghai'),
  PHOTO_ROOT: z.string().default('/photos'),
  DATA_ROOT: z.string().default('/data'),
  SCHEDULE: z.string().default('0 9 * * *'),
  PUBLISH_ENABLED: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),
  XHS_CREATOR_URL: z.string().url().default('https://creator.xiaohongshu.com/publish/publish'),
  XHS_HEADLESS: z.string().default('true').transform((v) => v.toLowerCase() === 'true'),
  XHS_SESSION_DIR: z.string().default('/data/xhs-session'),
  XHS_BROWSER_PATH: z.string().default('/opt/google/chrome/chrome'),
  XHS_PUBLISH_DELAY_MS: z.coerce.number().int().nonnegative().default(3000),
  GEOCODE_ENABLED: z.string().default('true').transform((v) => v.toLowerCase() === 'true'),
  GEOCODE_USER_AGENT: z.string().default('pic-poster-redbook/0.1'),
  // Kept for compatibility with older .env files; scoring uses MAX_SCORING_PHOTOS_PER_RUN.
  MAX_PHOTOS_PER_RUN: z.coerce.number().int().positive().default(500),
  MAX_SCORING_PHOTOS_PER_RUN: z.coerce.number().int().positive().max(500).default(500),
  SCORING_SCHEDULE: z.string().default('0 2 * * *'),
  SELECTION_SCHEDULE: z.string().default('0 3 * * *'),
  MAX_POSTS_PER_RUN: z.coerce.number().int().min(1).max(20).default(2),
  MAX_IMAGES_PER_POST: z.coerce.number().int().min(1).max(9).default(6),
  EVENT_GAP_HOURS: z.coerce.number().positive().default(6),
  EVENT_RADIUS_METERS: z.coerce.number().positive().default(300),
  MIN_SHORT_EDGE: z.coerce.number().int().positive().default(720),
  MIN_TECHNICAL_SCORE: z.coerce.number().min(0).max(100).default(50),
  MIN_QUALITY_SCORE: z.coerce.number().min(0).max(100).default(65),
  MIN_AESTHETIC_SCORE: z.coerce.number().min(0).max(100).default(68),
  MIN_STORY_SCORE: z.coerce.number().min(0).max(100).default(60),
  MIN_COMPOSITION_SCORE: z.coerce.number().min(0).max(100).default(60),
  MIN_TOTAL_SCORE: z.coerce.number().min(0).max(100).default(65),
  DUPLICATE_HASH_DISTANCE: z.coerce.number().int().min(0).max(16).default(4),
  FILE_SETTLE_SECONDS: z.coerce.number().int().nonnegative().default(60),
  VISION_API_URL: z.union([z.literal(''), z.string().url()]).default(''),
  VISION_API_KEY: z.string().default(''),
  VISION_MODEL: z.string().default(''),
  VISION_TIMEOUT_MS: z.coerce.number().int().positive().default(100000),
  DEFAULT_TITLE: z.string().default('今日照片'),
  DEFAULT_DESCRIPTION: z.string().default('记录生活中的风景。')
});

const parsed = envSchema.parse(process.env);
process.env.TZ = parsed.TZ;

export type ScheduleCycle = 'daily' | 'every2days' | 'every3days' | 'weekly' | 'custom';

const scheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const scheduleCycleSchema = z.enum(['daily', 'every2days', 'every3days', 'weekly', 'custom']);
const settingsPath = path.join(parsed.DATA_ROOT, 'settings.json');

function scheduleFor(cycle: Exclude<ScheduleCycle, 'custom'>, time: string, weeklyDay: number): string {
  const [hour, minute] = time.split(':').map(Number);
  const dayOfMonth = '*';
  const dayOfWeek = cycle === 'weekly' ? String(weeklyDay) : '*';
  return `${minute} ${hour} ${dayOfMonth} * ${dayOfWeek}`;
}

function scheduleDetails(schedule: string): { cycle: ScheduleCycle; time: string; weeklyDay: number } {
  const parts = schedule.trim().split(/\s+/);
  const hour = Number(parts[1]);
  const minute = Number(parts[0]);
  const time = Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : '09:00';
  if (parts.length === 5 && parts[2] === '*' && parts[3] === '*' && /^\d$/.test(parts[4])) return { cycle: 'weekly', time, weeklyDay: Number(parts[4]) };
  if (parts.length === 5 && parts[3] === '*' && parts[4] === '*') {
    if (parts[2] === '*/2') return { cycle: 'every2days', time, weeklyDay: 1 };
    if (parts[2] === '*/3') return { cycle: 'every3days', time, weeklyDay: 1 };
    if (parts[2] === '*') return { cycle: 'daily', time, weeklyDay: 1 };
  }
  return { cycle: 'custom', time, weeklyDay: 1 };
}

type PersistedSettings = {
  publishEnabled?: boolean;
  visionApiUrl?: string;
  visionApiKey?: string;
  visionModel?: string;
  xhsAccount?: string;
  xhsCreatorUrl?: string;
  schedule?: string;
  scheduleCycle?: ScheduleCycle;
  publishTime?: string;
  weeklyDay?: number;
  anchorDate?: string;
};

function readPersistedSettings(): PersistedSettings {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown;
    return value && typeof value === 'object' ? value as PersistedSettings : {};
  } catch { return {}; }
}

const persisted = readPersistedSettings();
const initialSchedule = persisted.schedule ?? parsed.SCHEDULE;
const inferred = scheduleDetails(initialSchedule);
const initialCycle = scheduleCycleSchema.safeParse(persisted.scheduleCycle ?? inferred.cycle).success
  ? (persisted.scheduleCycle ?? inferred.cycle) as ScheduleCycle : inferred.cycle;
const initialTime = scheduleTimeSchema.safeParse(persisted.publishTime ?? inferred.time).success
  ? (persisted.publishTime ?? inferred.time)! : inferred.time;
const initialWeeklyDay = Number.isInteger(persisted.weeklyDay) && persisted.weeklyDay! >= 0 && persisted.weeklyDay! <= 6
  ? persisted.weeklyDay! : inferred.weeklyDay;

export const config = {
  ...parsed,
  PUBLISH_ENABLED: false,
  SCHEDULE: initialCycle === 'custom' ? initialSchedule : scheduleFor(initialCycle, initialTime, initialWeeklyDay),
  VISION_API_URL: persisted.visionApiUrl ?? parsed.VISION_API_URL,
  VISION_API_KEY: persisted.visionApiKey ?? parsed.VISION_API_KEY,
  VISION_MODEL: persisted.visionModel ?? parsed.VISION_MODEL,
  XHS_CREATOR_URL: persisted.xhsCreatorUrl ?? parsed.XHS_CREATOR_URL,
  xhsAccount: persisted.xhsAccount ?? '',
  scheduleCycle: initialCycle,
  publishTime: initialTime,
  weeklyDay: initialWeeklyDay,
  anchorDate: persisted.anchorDate ?? localDate(new Date(), parsed.TZ),
  settingsPath,
  dbPath: path.join(parsed.DATA_ROOT, 'pic-poster.sqlite'),
  sessionDir: path.resolve(parsed.XHS_SESSION_DIR),
  maxPostsPerEvent: 3
};

export function getPublicSettings() {
  return {
    publishEnabled: config.PUBLISH_ENABLED,
    publishMode: 'manual_handoff' as const,
    visionApiUrl: config.VISION_API_URL,
    visionModel: config.VISION_MODEL,
    visionApiKeyConfigured: Boolean(config.VISION_API_KEY),
    xhsAccount: config.xhsAccount,
    xhsCreatorUrl: config.XHS_CREATOR_URL,
    schedule: config.SCHEDULE,
    scheduleCycle: config.scheduleCycle,
    publishTime: config.publishTime,
    weeklyDay: config.weeklyDay,
    timezone: config.TZ
    , anchorDate: config.anchorDate,
    maxPhotosPerRun: config.MAX_SCORING_PHOTOS_PER_RUN,
    scoringSchedule: config.SCORING_SCHEDULE,
    selectionSchedule: config.SELECTION_SCHEDULE,
    maxImagesPerPost: config.MAX_IMAGES_PER_POST
  };
}

export type RuntimeSettingsPatch = {
  publishEnabled?: boolean;
  visionApiUrl?: string;
  visionApiKey?: string;
  visionModel?: string;
  xhsAccount?: string;
  xhsCreatorUrl?: string;
  scheduleCycle?: ScheduleCycle;
  publishTime?: string;
  weeklyDay?: number;
};

export function updateRuntimeSettings(patch: RuntimeSettingsPatch) {
  if (patch.publishEnabled === true) throw new Error('当前使用人工交接模式，请在自己的浏览器中完成暂存或发布');
  const publishEnabled = false;
  const visionApiUrl = patch.visionApiUrl === undefined ? config.VISION_API_URL : patch.visionApiUrl.trim();
  const visionApiKey = patch.visionApiKey === undefined ? config.VISION_API_KEY : patch.visionApiKey;
  const visionModel = patch.visionModel === undefined ? config.VISION_MODEL : patch.visionModel.trim();
  const xhsAccount = patch.xhsAccount === undefined ? config.xhsAccount : patch.xhsAccount.trim();
  const xhsCreatorUrl = patch.xhsCreatorUrl === undefined ? config.XHS_CREATOR_URL : patch.xhsCreatorUrl.trim();
  const scheduleCycle = patch.scheduleCycle ?? config.scheduleCycle;
  const publishTime = patch.publishTime ?? config.publishTime;
  const weeklyDay = patch.weeklyDay ?? config.weeklyDay;
  if (visionApiUrl && !z.string().url().safeParse(visionApiUrl).success) throw new Error('视觉模型 URL 格式不正确');
  if (!z.string().url().safeParse(xhsCreatorUrl).success) throw new Error('小红书创作中心 URL 格式不正确');
  if (!scheduleCycleSchema.safeParse(scheduleCycle).success || scheduleCycle === 'custom') throw new Error('发布周期不支持');
  if (!scheduleTimeSchema.safeParse(publishTime).success) throw new Error('发布时间必须是 HH:mm 格式');
  if (!Number.isInteger(weeklyDay) || weeklyDay < 0 || weeklyDay > 6) throw new Error('每周发布日不正确');
  const schedule = scheduleFor(scheduleCycle, publishTime, weeklyDay);
  const anchorDate = scheduleCycle === config.scheduleCycle ? config.anchorDate : localDate(new Date(), config.TZ);
  const saved = { publishEnabled, visionApiUrl, visionApiKey, visionModel, xhsAccount, xhsCreatorUrl, schedule, scheduleCycle, publishTime, weeklyDay, anchorDate };
  fs.mkdirSync(parsed.DATA_ROOT, { recursive: true });
  const tempPath = `${settingsPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, settingsPath);
  config.VISION_API_URL = visionApiUrl;
  config.PUBLISH_ENABLED = publishEnabled;
  config.VISION_API_KEY = visionApiKey;
  config.VISION_MODEL = visionModel;
  config.XHS_CREATOR_URL = xhsCreatorUrl;
  config.xhsAccount = xhsAccount;
  config.SCHEDULE = schedule;
  config.scheduleCycle = scheduleCycle;
  config.publishTime = publishTime;
  config.weeklyDay = weeklyDay;
  config.anchorDate = anchorDate;
  return getPublicSettings();
}
