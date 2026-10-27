import { config } from './config.js';
import { store, selectionPolicy } from './repository.js';
import { scheduleDrafts } from './drafts.js';
import { logger } from './logger.js';
import { serialized } from './operations.js';

export type SelectionResult = {
  scanned: number;
  eligible: number;
  events: number;
  draftsCreated: number;
};

export type SelectionStatus = {
  running: boolean;
  phase: 'idle' | 'grouping' | 'queueing' | 'completed' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  scanned: number;
  eligible: number;
  events: number;
  draftsCreated: number;
  lastResult: SelectionResult | null;
  error: string | null;
};

const emptyResult = (): SelectionResult => ({ scanned: 0, eligible: 0, events: 0, draftsCreated: 0 });
let selectionState: SelectionStatus = {
  running: false, phase: 'idle', startedAt: null, finishedAt: null,
  ...emptyResult(), lastResult: null, error: null
};
let currentSelection: Promise<SelectionResult> | null = null;

export function getSelectionStatus(): SelectionStatus {
  return { ...selectionState, lastResult: selectionState.lastResult ? { ...selectionState.lastResult } : null };
}

export function selectAndQueue(): Promise<SelectionResult> {
  if (!currentSelection) {
    selectionState = { running: true, phase: 'grouping', startedAt: new Date().toISOString(), finishedAt: null,
      ...emptyResult(), lastResult: selectionState.lastResult, error: null };
    currentSelection = serialized(async () => {
      selectionState.phase = 'grouping';
      store.reclassifyStoryRejected();
      store.reclassifyMetadataStatuses();
      store.groupPhotos(config.EVENT_GAP_HOURS, config.EVENT_RADIUS_METERS);
      const photos = store.listPhotos();
      const scanned = photos.filter(photo => photo.analysisAttemptedAt !== null).length;
      const eligible = photos.filter(photo => photo.status === 'pending').length;
      selectionState = { ...selectionState, phase: 'queueing', scanned, eligible, events: store.listEvents().length };
      const draftsCreated = store.ensureDrafts(selectionPolicy);
      scheduleDrafts();
      return { scanned, eligible, events: store.listEvents().length, draftsCreated };
    }).then(result => {
      selectionState = { ...selectionState, running: false, phase: 'completed', finishedAt: new Date().toISOString(), ...result, lastResult: result, error: null };
      return result;
    }).catch(error => {
      selectionState = { ...selectionState, running: false, phase: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      logger.error({ error: String(error) }, 'photo selection failed');
      throw error;
    }).finally(() => { currentSelection = null; });
  }
  return currentSelection;
}

export function startSelection(): { accepted: boolean; status: SelectionStatus } {
  if (currentSelection) return { accepted: false, status: getSelectionStatus() };
  void selectAndQueue().catch(() => undefined);
  return { accepted: true, status: getSelectionStatus() };
}
