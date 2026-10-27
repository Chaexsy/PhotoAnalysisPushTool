import { z } from 'zod';
import type { VisionAssessment } from './types.js';

const score = z.number().finite().min(0).max(100);
export const manualScoresSchema = z.object({
  technicalScore: score, quality: score, composition: score, aesthetics: score, story: score
}).strict();
export type ManualScores = z.infer<typeof manualScoresSchema>;

export function totalScore(technical: number, assessment: Pick<VisionAssessment, 'quality' | 'composition' | 'aesthetics' | 'story'>): number {
  return Math.round(technical * 0.1 + assessment.quality * 0.2 + assessment.composition * 0.2 + assessment.aesthetics * 0.3 + assessment.story * 0.2);
}
