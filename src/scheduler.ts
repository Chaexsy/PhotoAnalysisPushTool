import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { scanPhotos } from './scanner.js';
import { selectAndQueue } from './selector.js';

let scoringTask: { stop(): void } | null = null;
let selectionTask: { stop(): void } | null = null;
let running = false;

async function runJob(reason: string, job: 'score' | 'select') {
  if (running) { logger.warn({ reason, job }, 'scheduled job already running'); return; }
  running = true;
  try {
    if (job === 'score') await scanPhotos();
    else if (job === 'select') await selectAndQueue();
  } catch (error) { logger.error({ error, reason, job }, 'scheduled job failed'); }
  finally { running = false; }
}

function scheduleTasks() {
  scoringTask?.stop(); selectionTask?.stop();
  scoringTask = cron.schedule(config.SCORING_SCHEDULE, () => void runJob('scoring-schedule', 'score'), { timezone: config.TZ }) as { stop(): void };
  selectionTask = cron.schedule(config.SELECTION_SCHEDULE, () => void runJob('selection-schedule', 'select'), { timezone: config.TZ }) as { stop(): void };
  logger.info({ publishMode: 'manual_handoff', scoringSchedule: config.SCORING_SCHEDULE, selectionSchedule: config.SELECTION_SCHEDULE, timezone: config.TZ }, 'scheduler scheduled');
}

export function startScheduler() {
  scheduleTasks();
}

export function reschedule() {
  scheduleTasks();
}
