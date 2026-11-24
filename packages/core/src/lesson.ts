/** Lesson data model + 学习笔记 Markdown 生成（结构对齐原套件模板）。 */

import type { LessonSegment } from './subtitles';
import type { MinedLesson } from './miner';
import { makeId } from './books';

export const LESSON_NOTE_NAME = '学习笔记.md';

export interface LessonMedia {
  kind: 'youtube' | 'bilibili' | 'local' | 'remote';
  videoId?: string;
  bvid?: string;
  /** vault-relative path of a local media file */
  path?: string;
  /** streaming URL for kind 'remote'（如 RSS enclosure 原声） */
  url?: string;
  subtitlePath?: string;
}

export interface LessonWordSnap {
  lemma: string;
  phoneticUS: string;
  senses: string[];
  tags: string[];
  segIdx: number;
  count: number;
}

export interface LessonClips {
  /** hard sentence index → clips/hardXX.mp3（相对教程目录） */
  hard: Record<number, string>;
  /** paragraph index → clips/paraXX.mp3 */
  para: Record<number, string>;
}

export interface LessonData {
  id: string;
  title: string;
  createdAt: string;
  source: { kind: 'article' | 'youtube' | 'bilibili' | 'local-media' | 'note'; url?: string; feedName?: string };
  media?: LessonMedia;
  segments: LessonSegment[];
  words: LessonWordSnap[];
  hard: Array<{ segIdx: number; score: number }>;
  clips?: LessonClips;
}

export function buildLessonData(args: {
  title: string;
  source: LessonData['source'];
  media?: LessonMedia;
  segments: LessonSegment[];
  mined: MinedLesson;
}): LessonData {
  return {
    id: makeId('lesson'),
    title: args.title,
    createdAt: new Date().toISOString(),
    source: args.source,
    media: args.media,
    segments: args.segments,
    words: args.mined.words.map((w) => ({
      lemma: w.entry.lemma,
      phoneticUS: w.entry.phoneticUS,
      senses: w.entry.senses.slice(0, 2),
      tags: w.entry.tags,
      segIdx: w.segIdx,
      count: w.count,
    })),
    hard: args.mined.hard,
  };
}

export function fmtTime(sec?: number): string {
  if (sec === undefined) return '';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export interface ParaRange {
  para: number;
  firstSegIdx: number;
  start?: number;
  end?: number;
  text: string;
}

/** 按段落聚合句子（全文章节与段落切片共用）。 */
/** 按字幕自带的段落号分组（文章类来源的段落结构是真实的）。 */
function naturalParas(segments: LessonSegment[]): ParaRange[] {
  const out: ParaRange[] = [];
  segments.forEach((seg, idx) => {
    const cur = out[out.length - 1];
    if (!cur || cur.para !== seg.paragraph) {
      out.push({ para: seg.paragraph, firstSegIdx: idx, start: seg.start, end: seg.end, text: seg.text });
    } else {
      cur.text += ` ${seg.text}`;
      if (seg.end !== undefined) cur.end = seg.end;
    }
  });
  return out;
}

export function paraRanges(segments: LessonSegment[]): ParaRange[] {
  const natural = naturalParas(segments);
  // 字幕/转写几乎没有段落信息（整篇一两个巨段）：按停顿与长度重新分段，
  // 目标 4~6 句一段，优先断在停顿处——与旧套件的全文分段观感一致。
  const tooCoarse = natural.some((r, i) => {
    const nextFirst = natural[i + 1]?.firstSegIdx ?? segments.length;
    return nextFirst - r.firstSegIdx > 7 || r.text.length > 600;
  });
  if (!tooCoarse || segments.length <= 6) return natural;

  // 旧套件实测规律：每段约 30~45 秒、4~7 句、~450 字符，在句间停顿处收段。
  const out: ParaRange[] = [];
  let closeNext = true;
  segments.forEach((seg, idx) => {
    if (closeNext) {
      out.push({ para: out.length, firstSegIdx: idx, start: seg.start, end: seg.end, text: seg.text });
    } else {
      const cur = out[out.length - 1];
      cur.text += ` ${seg.text}`;
      if (seg.end !== undefined) cur.end = seg.end;
    }
    const cur = out[out.length - 1];
    const next = segments[idx + 1];
    if (!next) { closeNext = true; return; }
    const count = idx - cur.firstSegIdx + 1;
    const hasTime = cur.start !== undefined && seg.end !== undefined;
    const dur = hasTime ? (seg.end as number) - (cur.start as number) : 0;
    const gapNext = next.start !== undefined && seg.end !== undefined ? next.start - seg.end : 0;
    closeNext = hasTime
      ? (dur >= 34 || cur.text.length >= 520
        || (dur >= 20 && gapNext >= 0.35)
        || (dur >= 27 && gapNext >= 0.08))
      : (count >= 6 || cur.text.length >= 500);
  });
  // 碎尾段（<8s 或 <60 字符）并回前一段
  for (let i = out.length - 1; i > 0; i--) {
    const p = out[i];
    const dur = p.start !== undefined && p.end !== undefined ? p.end - p.start : 99;
    if (dur < 8 || p.text.length < 60) {
      const prev = out[i - 1];
      prev.text += ` ${p.text}`;
      if (p.end !== undefined) prev.end = p.end;
      out.splice(i, 1);
    }
  }
  out.forEach((p, i) => { p.para = i; });
  return out;
}

function jumpSpan(data: LessonData, segIdx: number, endSegIdx?: number): string {
  const seg = data.segments[segIdx];
  const t = seg?.start !== undefined ? ` ${fmtTime(seg.start)}` : '';
  const end = endSegIdx !== undefined && endSegIdx > segIdx ? ` data-seg-end="${endSegIdx}"` : '';
  return `<span class="lexora-jump" data-seg="${segIdx}"${end}>▶${t}</span>`;
}

function slug(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function lessonFolderName(title: string, date = new Date()): string {
  const d = date.toISOString().slice(0, 10);
  return `${d}_${slug(title) || 'untitled'}`;
}

function cell(s: string): string {
  return s.replace(/\|/g, '/').replace(/\n/g, ' ');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 学习笔记正文（结构复用原套件模板：生词表/长难句/全文段落/复盘）。 */
export function lessonMarkdown(data: LessonData): string {
  const L: string[] = [];
  const lastSeg = [...data.segments].reverse().find((s) => s.end !== undefined);
  const duration = lastSeg?.end !== undefined ? fmtTime(lastSeg.end) : '';

  // ---- frontmatter ----
  L.push('---');
  L.push(`lexora-lesson: ${data.id}`);
  L.push(`title: "${data.title.replace(/"/g, "'")}"`);
  if (data.source.url) {
    L.push(data.source.kind === 'youtube' || data.source.kind === 'bilibili' ? `video: ${data.source.url}` : `source: "${data.source.url}"`);
  }
  if (data.source.feedName) L.push(`creator: "${data.source.feedName.replace(/"/g, "'")}"`);
  L.push('tags:');
  L.push('  - english/lesson');
  if (data.source.kind === 'youtube') L.push('  - english/youtube');
  if (data.source.kind === 'bilibili') L.push('  - english/bilibili');
  L.push(`new_words: ${data.words.length}`);
  L.push(`hard_sentences: ${data.hard.length}`);
  if (duration) L.push(`duration: ${duration}`);
  L.push(`created: ${data.createdAt.slice(0, 10)}`);
  L.push('status: new');
  L.push('---');
  L.push('');
  L.push(`# ${data.title}`);
  L.push('');
  L.push('```lexora-player');
  L.push(data.id);
  L.push('```');
  L.push('');
  L.push('> [!tip] 点任意 ▶ 跳到对应句子并循环播放；🎙 可跟读录音对比。生词右键加入单词本。');
  L.push('');

  // ---- 生词表 ----
  L.push(`## 🔑 生词（${data.words.length}）`);
  L.push('');
  L.push('| # | 单词 | 音标 | 释义 | 例句 | 片段 |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  data.words.forEach((w, i) => {
    const sentence = data.segments[w.segIdx]?.text ?? '';
    L.push(
      `| ${i + 1} | **${w.lemma}** | ${cell(w.phoneticUS)} | ${cell(w.senses.join('；'))} | ` +
      `${cell(truncate(sentence, 60))} | ${jumpSpan(data, w.segIdx)} |`,
    );
  });
  L.push('');

  // ---- 长难句 ----
  L.push(`## 🧩 长难句（${data.hard.length}）`);
  L.push('');
  data.hard.forEach((h, i) => {
    const seg = data.segments[h.segIdx];
    if (!seg) return;
    L.push(`### ${i + 1}. ${jumpSpan(data, h.segIdx)}`);
    L.push('');
    const clip = data.clips?.hard[h.segIdx];
    if (clip) L.push(`![[${clip}]]`);
    L.push(`> ${seg.text}`);
    L.push('');
    L.push('- **结构**：');
    L.push('- **翻译**：');
    L.push('- **跟读**：[ ] 1 遍  [ ] 3 遍  [ ] 影子跟读');
    L.push('');
  });

  // ---- 全文 ----
  L.push('## 📜 全文（每段可点跳）');
  L.push('');
  const ranges = paraRanges(data.segments);
  ranges.forEach((p, i) => {
    const clip = data.clips?.para[p.para];
    const lastSegIdx = (ranges[i + 1]?.firstSegIdx ?? data.segments.length) - 1;
    const head = `${clip ? `![[${clip}]] ` : ''}${jumpSpan(data, p.firstSegIdx, lastSegIdx)}`;
    L.push(head);
    L.push(p.text);
    L.push('');
  });

  // ---- 复盘 ----
  L.push('## ✍️ 复盘');
  L.push('');
  L.push('- 主旨：');
  L.push('- 可复用表达：');
  L.push('- 下次注意：');
  L.push('');

  return L.join('\n');
}
