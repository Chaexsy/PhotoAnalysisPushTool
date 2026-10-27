export const MAX_XHS_TOPICS = 10;
export const MAX_XHS_TOPIC_LENGTH = 30;

export type XhsLookupKind = 'topic' | 'location';

/** Normalize text stored from the XHS candidate picker. */
export function normalizeXhsText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim();
}

export function normalizeTopics(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const topic = normalizeXhsText(value).slice(0, MAX_XHS_TOPIC_LENGTH);
    if (!topic) continue;
    const key = topic.toLocaleLowerCase('zh-CN');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(topic);
    if (result.length >= MAX_XHS_TOPICS) break;
  }
  return result;
}

export interface CandidateMatch {
  kind: XhsLookupKind;
  query: string;
  requested: string;
  candidates: string[];
  exact: string[];
}

export function matchXhsCandidate(kind: XhsLookupKind, requested: string, candidates: unknown[]): CandidateMatch {
  const query = normalizeXhsText(requested);
  const normalized = candidates.map(normalizeXhsText).filter(Boolean);
  const exact = normalized.filter(candidate => candidate === query);
  return { kind, query, requested: query, candidates: normalized, exact };
}

export function requireUniqueXhsCandidate(kind: XhsLookupKind, requested: string, candidates: unknown[]): string {
  const match = matchXhsCandidate(kind, requested, candidates);
  if (!match.query) throw new Error(kind === 'topic' ? '话题不能为空' : '地点不能为空');
  if (match.exact.length === 0) throw new Error(`${kind === 'topic' ? '话题' : '地点'}“${match.query}”没有唯一完全匹配候选`);
  if (match.exact.length > 1) throw new Error(`${kind === 'topic' ? '话题' : '地点'}“${match.query}”存在多个同名候选，请缩小关键词`);
  return match.exact[0];
}
