import { config } from './config.js';
import { PhotoStore } from './db.js';
import type { SelectionPolicy } from './selection.js';

export const store = new PhotoStore(config.dbPath);
export const selectionPolicy: SelectionPolicy = {
  minQuality: config.MIN_QUALITY_SCORE, minAesthetics: config.MIN_AESTHETIC_SCORE, minStory: config.MIN_STORY_SCORE,
  minComposition: config.MIN_COMPOSITION_SCORE, minTotal: config.MIN_TOTAL_SCORE,
  minTechnical: config.MIN_TECHNICAL_SCORE, minShortEdge: config.MIN_SHORT_EDGE,
  maxImages: config.MAX_IMAGES_PER_POST, duplicateDistance: config.DUPLICATE_HASH_DISTANCE
};
