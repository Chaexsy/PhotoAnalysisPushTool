import { describe, expect, it } from 'vitest';
import { matchXhsCandidate, normalizeTopics, requireUniqueXhsCandidate } from '../src/xhs-metadata.js';

describe('XHS metadata candidates', () => {
  it('normalizes, deduplicates, limits topic count and length', () => {
    const topics = normalizeTopics([' #旅行 ', '旅行', '风景'.repeat(20), ...Array.from({ length: 12 }, (_, i) => `话题${i}`)]);
    expect(topics[0]).toBe('旅行');
    expect(topics).toHaveLength(10);
    expect([...topics[1]].length).toBe(30);
  });

  it('requires one exact candidate and rejects missing or ambiguous values', () => {
    expect(requireUniqueXhsCandidate('topic', '壶口瀑布', ['壶口瀑布', '壶口瀑布旅游'])).toBe('壶口瀑布');
    expect(() => requireUniqueXhsCandidate('topic', '壶口瀑布', ['壶口瀑布旅游'])).toThrow('没有唯一完全匹配');
    expect(() => requireUniqueXhsCandidate('location', '壶口瀑布', ['壶口瀑布', '壶口瀑布'])).toThrow('多个同名候选');
    expect(matchXhsCandidate('location', ' 西湖 ', ['西湖']).exact).toEqual(['西湖']);
  });
});
