/**
 * ESL 练习工作纸清洗：Breaking News English 这类站点的页面 = 一小段新闻正文 +
 * 大量课堂练习（WORD SEARCH / 填空 / 讨论题）。生成教程与阅读页都只要正文，
 * 在首个练习区标记处截断。
 */
const MARKERS: RegExp[] = [
  /\bWARM-?UPS?\b/,
  /Before reading \/ listening/i,
  /After reading \/ listening/i,
  /\bWORD SEARCH\b/,
  /\bCOMPREHENSION QUESTIONS\b/i,
  /\bTRUE \/ FALSE\b/,
  /\bSYNONYM MATCH\b/i,
  /\bPHRASE MATCH\b/i,
  /\bLISTENING GAP FILL\b/i,
  /\bSTUDENT A'?S QUESTIONS\b/i,
  /\bSPELLING\b[\s\S]{0,40}\bparagraph\b/i,
  /Sources\s*:?\s*https?:/i,
];

const KNOWN_WORKSHEET_HOSTS = /breakingnewsenglish\.com|eslfast|news.?in.?levels/i;

/** 截断练习区。通用文本：已知站点命中 1 个标记即截；其他站点需命中 ≥2 个不同标记才截（防误伤）。 */
export function cutWorksheet(text: string, sourceUrl?: string): string {
  const hits: number[] = [];
  for (const re of MARKERS) {
    const m = text.match(re);
    if (m?.index !== undefined && m.index > 200) hits.push(m.index);
  }
  if (hits.length === 0) return text;
  const known = sourceUrl ? KNOWN_WORKSHEET_HOSTS.test(sourceUrl) : false;
  if (!known && hits.length < 2) return text;
  return text.slice(0, Math.min(...hits)).trimEnd();
}
