import { Notice, TFile, normalizePath, requestUrl } from 'obsidian';
import { Readability } from '@mozilla/readability';
import JSZip from 'jszip';
import { findFfmpeg, runFf } from './ffmpeg';
import {
  LESSON_NOTE_NAME, buildLessonData, cuesToSegments, htmlToText, lessonFolderName,
  lessonMarkdown, mineLesson, paraRanges, parseSubtitle, textToSegments,
  type LessonData, type LessonMedia, type LessonSegment, type MineOptions,
} from '@elp/core';
import type ElpPlugin from './main';
import { mineLevelsOf } from './settings';

function mineOpts(plugin: ElpPlugin, kind: 'video' | 'article'): MineOptions {
  const s = plugin.settings;
  return {
    levels: mineLevelsOf(s),
    maxWords: kind === 'video' ? s.maxWordsVideo : s.maxWordsArticle,
    maxSentences: s.maxSentences,
    minRank: s.minRank,
  };
}

function excluder(plugin: ElpPlugin): (lemma: string) => boolean {
  return (lemma) => plugin.store.isCollected(lemma) || plugin.store.isMastered(lemma);
}

async function writeLesson(plugin: ElpPlugin, data: LessonData): Promise<string> {
  const folder = normalizePath(`${plugin.settings.lessonsFolder}/${lessonFolderName(data.title)}`);
  await plugin.storage.mkdir(folder);
  await plugin.storage.writeText(`${folder}/lesson.json`, JSON.stringify(data, null, 1));
  const mdPath = `${folder}/${LESSON_NOTE_NAME}`;
  await plugin.storage.writeText(mdPath, lessonMarkdown(data));
  return mdPath;
}

/** 长难句 + 段落原声切片（需本地媒体 + worker ffmpeg）。失败不阻断生成。 */
/** 本地 ffmpeg 切片：逐段 -ss/-to 抽 mp3，零上传。环境不满足或失败返回 false 走 worker。 */
async function makeClipsLocally(
  plugin: ElpPlugin,
  mediaFile: TFile,
  segs: Array<{ name: string; start: number; end: number }>,
  folder: string,
  notice: Notice,
): Promise<boolean> {
  const ffmpeg = findFfmpeg();
  const adapter = plugin.app.vault.adapter as { getBasePath?: () => string };
  const base = adapter.getBasePath?.();
  const req = (window as Window & { require?: (m: string) => unknown }).require;
  if (!ffmpeg || !base || !req) return false;
  const pathMod = req('path') as typeof import('path');
  const srcAbs = pathMod.join(base, ...mediaFile.path.split('/'));
  await plugin.storage.mkdir(`${folder}/clips`);
  try {
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      notice.setMessage(`本地切片 ${i + 1}/${segs.length}…`);
      const destAbs = pathMod.join(base, ...`${folder}/clips/${seg.name}.mp3`.split('/'));
      await runFf(ffmpeg, [
        '-y', '-ss', seg.start.toFixed(3), '-to', seg.end.toFixed(3),
        '-i', srcAbs, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', destAbs,
      ]);
    }
    return true;
  } catch (e) {
    console.error('[lexora] local clip failed, falling back to worker', e);
    return false;
  }
}

async function makeClips(plugin: ElpPlugin, data: LessonData): Promise<void> {
  const mediaPath = data.media?.kind === 'local' ? data.media.path : undefined;
  if (!mediaPath) return;
  const caps = await plugin.worker.capabilities();
  if (!caps?.features.clip) return;
  const mediaFile = plugin.app.vault.getAbstractFileByPath(normalizePath(mediaPath));
  if (!(mediaFile instanceof TFile)) return;

  const pad = (n: number) => String(n).padStart(2, '0');
  const segs: Array<{ name: string; start: number; end: number }> = [];
  const hardMap: Record<number, string> = {};
  data.hard.forEach((h, i) => {
    const seg = data.segments[h.segIdx];
    if (seg?.start === undefined || seg.end === undefined) return;
    const name = `hard${pad(i + 1)}`;
    // 句切片：首尾各留 0.3s，起音收音完整
    segs.push({ name, start: Math.max(0, seg.start - 0.3), end: seg.end + 0.3 });
    hardMap[h.segIdx] = `clips/${name}.mp3`;
  });
  const paraMap: Record<number, string> = {};
  for (const p of paraRanges(data.segments)) {
    if (p.start === undefined || p.end === undefined) continue;
    const name = `para${pad(p.para + 1)}`;
    // 段切片：前导 0.8s、收尾 0.4s（旧套件同款余量）
    segs.push({ name, start: Math.max(0, p.start - 0.8), end: p.end + 0.4 });
    paraMap[p.para] = `clips/${name}.mp3`;
  }
  if (segs.length === 0) return;

  if (!plugin.license.ensurePro('worker-advanced')) return; // 无 Pro 时教程仍生成，只是没有切片
  const notice = new Notice('生成原声切片…', 0);
  const clipFolder = normalizePath(`${plugin.settings.lessonsFolder}/${lessonFolderName(data.title, new Date(data.createdAt))}`);
  // 桌面端优先本地 ffmpeg 切片：零上传（大视频场景从"必死"变秒级），worker 留作兜底
  if (await makeClipsLocally(plugin, mediaFile, segs, clipFolder, notice)) {
    data.clips = { hard: hardMap, para: paraMap };
    notice.setMessage(`切片完成：${segs.length} 段（本地）`);
    window.setTimeout(() => notice.hide(), 3000);
    return;
  }
  try {
    const zipBytes = await plugin.worker.clipJob(mediaFile, segs, (status, progress) => {
      notice.setMessage(status === 'running' ? `切片 ${(progress * 100).toFixed(0)}%…` : '切片排队中…');
    });
    const zip = await JSZip.loadAsync(zipBytes);
    const folder = clipFolder;
    await plugin.storage.mkdir(`${folder}/clips`);
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const buf = await entry.async('arraybuffer');
      await plugin.storage.writeBinary(`${folder}/clips/${name}`, buf);
    }
    data.clips = { hard: hardMap, para: paraMap };
    notice.setMessage(`切片完成：${segs.length} 段`);
    window.setTimeout(() => notice.hide(), 3000);
  } catch (e) {
    notice.hide();
    new Notice(`切片跳过：${(e as Error).message}`);
  }
}

async function openLesson(plugin: ElpPlugin, path: string): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) return;
  // 阅读模式打开：播放器与 ▶ 跳转在阅读视图下体验最佳。
  await plugin.app.workspace.getLeaf(true).openFile(file, {
    state: { mode: 'preview' },
  });
}

async function finish(
  plugin: ElpPlugin, data: LessonData, itemId?: string,
): Promise<string> {
  await makeClips(plugin, data);
  const path = await writeLesson(plugin, data);
  await plugin.license.consumeLessonQuota();
  if (itemId) await plugin.feeds.markGenerated(itemId, path);
  new Notice(`教程已生成：生词 ${data.words.length} · 长难句 ${data.hard.length}`);
  await openLesson(plugin, path);
  plugin.refreshAll();
  return path;
}

/**
 * YouTube 课（完整管线，同旧套件）：worker 下载音轨 mp3 → 本地对齐字幕 →
 * 自动切 hard/para 切片。时间轴与播放完全一致，离线可用。
 */
export async function generateFromYoutubeAudio(
  plugin: ElpPlugin,
  args: {
    title: string;
    videoId: string;
    vtt: string;
    sourceUrl?: string;
    feedName?: string;
    itemId?: string;
  },
): Promise<void> {
  if (!plugin.license.checkLessonQuota()) return;
  if (!plugin.license.ensurePro('worker-advanced')) return;
  const notice = new Notice('下载视频…', 0);
  try {
    // 先要 720p 视频（同旧套件）；视频流拿不到再退音轨
    let mediaName = 'video.mp4';
    let buf: ArrayBuffer;
    try {
      buf = await plugin.worker.ytMedia(args.videoId, true, (_s, p) => {
        notice.setMessage(`下载视频… ${Math.round(p * 100)}%`);
      });
    } catch {
      notice.setMessage('视频流不可用，改下音轨…');
      mediaName = 'audio.mp3';
      buf = await plugin.worker.ytMedia(args.videoId, false, (_s, p) => {
        notice.setMessage(`下载音频… ${Math.round(p * 100)}%`);
      });
    }
    const folder = normalizePath(`${plugin.settings.lessonsFolder}/${lessonFolderName(args.title)}`);
    await plugin.storage.mkdir(folder);
    const audioPath = `${folder}/${mediaName}`;
    await plugin.storage.writeBinary(audioPath, buf);

    notice.setMessage('解析字幕、挖掘生词…');
    const cues = parseSubtitle(args.vtt);
    if (cues.length === 0) throw new Error('字幕解析为空');
    const segments = cuesToSegments(cues);
    const mined = await mineLessonChecked(plugin, segments, 'video');
    const data = buildLessonData({
      title: args.title,
      source: { kind: 'youtube', url: args.sourceUrl, feedName: args.feedName },
      media: { kind: 'local', path: audioPath },
      segments,
      mined,
    });
    notice.hide();
    await finish(plugin, data, args.itemId);
  } catch (e) {
    notice.hide();
    new Notice(`生成失败：${(e as Error).message}`);
  }
}

/** 删除整篇教程（学习笔记 + lesson.json + clips/ + recordings/），移入系统回收站可找回。 */
export async function deleteLesson(plugin: ElpPlugin, notePath: string): Promise<void> {
  const dir = normalizePath(notePath.split('/').slice(0, -1).join('/'));
  const folder = plugin.app.vault.getAbstractFileByPath(dir);
  try {
    if (folder) await plugin.app.vault.trash(folder, true);
    else if (await plugin.app.vault.adapter.exists(dir)) await plugin.app.vault.adapter.rmdir(dir, true);
  } catch (e) {
    new Notice(`删除失败：${(e as Error).message}`);
    return;
  }
  await plugin.feeds.unmarkByPath(dir);
  new Notice('教程已删除（文件在系统回收站可找回）');
  plugin.refreshAll();
}

/** 条目没有 enclosure 时，抓页面嗅探音频链接（BBC 等站点 mp3 在页内）。 */
export async function sniffPageAudio(url: string): Promise<string | undefined> {
  try {
    const res = await requestUrl({ url, headers: { 'user-agent': 'Mozilla/5.0' } });
    const m = res.text.match(/https?:\/\/[^"'\s<>]+?\.(?:mp3|m4a)(?:\?[^"'\s<>]*)?/i);
    return m?.[0];
  } catch {
    return undefined;
  }
}

/** 文章（RSS item 或任意 URL）→ 教程。优先抓全文，Readability 提正文。 */
export async function generateFromArticle(
  plugin: ElpPlugin,
  args: {
    title: string; url?: string; contentHtml?: string; feedName?: string; itemId?: string;
    /** RSS enclosure 原声：文本教程会内嵌整段播放器（句级跳转走 TTS） */
    audioUrl?: string;
  },
): Promise<void> {
  if (!plugin.license.checkLessonQuota()) return;
  const notice = new Notice('正在抓取与解析文章…', 0);
  try {
    let text = '';
    if (args.url) {
      try {
        const res = await requestUrl({ url: args.url, headers: { 'user-agent': 'Mozilla/5.0' } });
        const doc = new DOMParser().parseFromString(res.text, 'text/html');
        const article = new Readability(doc).parse();
        if (article?.textContent && article.textContent.trim().length > 200) {
          text = article.textContent;
        }
      } catch { /* fall back to feed content */ }
    }
    if (!text && args.contentHtml) text = htmlToText(args.contentHtml);
    if (!text) throw new Error('拿不到正文（站点可能反爬，试试在浏览器另存后用「从当前笔记生成」）');

    const segments = textToSegments(text);
    if (segments.length < 3) throw new Error('正文太短，不值得挖');
    const mined = await mineLessonChecked(plugin, segments, 'article');
    const data = buildLessonData({
      title: args.title,
      source: { kind: 'article', url: args.url, feedName: args.feedName },
      media: args.audioUrl ? { kind: 'remote', url: args.audioUrl } : undefined,
      segments,
      mined,
    });
    notice.hide();
    await finish(plugin, data, args.itemId);
  } catch (e) {
    notice.hide();
    new Notice(`生成失败：${(e as Error).message}`);
  }
}

/**
 * 原声文章教程：下载 enclosure 音频 → 伴侣服务转写 → 按时间轴对齐生成。
 * BBC 6 Minute 这类"带 mp3 的文章源"由此获得句级原声跟读与跳转。
 */
export async function generateArticleOriginal(
  plugin: ElpPlugin,
  args: { title: string; url?: string; audioUrl: string; feedName?: string; itemId?: string },
): Promise<void> {
  if (!plugin.license.checkLessonQuota()) return;
  if (!plugin.license.ensurePro('worker-advanced')) return;
  const notice = new Notice('下载原声音频…', 0);
  try {
    const folder = normalizePath(`${plugin.settings.lessonsFolder}/${lessonFolderName(args.title)}`);
    await plugin.storage.mkdir(folder);
    const res = await requestUrl({ url: args.audioUrl, headers: { 'user-agent': 'Mozilla/5.0' } });
    const ext = (args.audioUrl.match(/\.(mp3|m4a|aac|ogg)(?:\?|$)/i)?.[1] ?? 'mp3').toLowerCase();
    const audioPath = `${folder}/audio.${ext}`;
    const existing = plugin.app.vault.getAbstractFileByPath(audioPath);
    const audioFile = existing instanceof TFile
      ? (await plugin.app.vault.modifyBinary(existing, res.arrayBuffer), existing)
      : await plugin.app.vault.createBinary(audioPath, res.arrayBuffer);

    notice.setMessage('伴侣服务转写中…');
    const vtt = await plugin.worker.transcribe(audioFile, (status, progress) => {
      notice.setMessage(status === 'running' ? `转写中 ${(progress * 100).toFixed(0)}%…` : '排队中…');
    });
    const vttPath = `${folder}/audio.en.vtt`;
    await plugin.storage.writeText(vttPath, vtt);

    const segments = cuesToSegments(parseSubtitle(vtt));
    const mined = await mineLessonChecked(plugin, segments, 'video');
    const data = buildLessonData({
      title: args.title,
      source: { kind: 'article', url: args.url, feedName: args.feedName },
      media: { kind: 'local', path: audioPath, subtitlePath: vttPath },
      segments,
      mined,
    });
    notice.hide();
    await finish(plugin, data, args.itemId);
  } catch (e) {
    notice.hide();
    new Notice(`原声教程生成失败：${(e as Error).message}`);
  }
}

/** YouTube / 本地媒体 + 字幕文件 → 教程（原声跟读 + 跳转）。 */
export async function generateFromMedia(
  plugin: ElpPlugin,
  args: {
    title: string;
    media: LessonMedia;
    subtitleFile?: TFile;
    /** 直接给字幕文本（如自动拉取的 YouTube 字幕），与 subtitleFile 二选一。 */
    subtitleText?: string;
    sourceUrl?: string;
    feedName?: string;
    itemId?: string;
  },
): Promise<void> {
  if (!plugin.license.checkLessonQuota()) return;
  const notice = new Notice('正在解析字幕…', 0);
  try {
    const raw = args.subtitleText ?? (args.subtitleFile ? await plugin.app.vault.cachedRead(args.subtitleFile) : '');
    if (!raw) throw new Error('没有字幕来源');
    const cues = parseSubtitle(raw);
    if (cues.length === 0) throw new Error('字幕解析为空（支持 .vtt / .srt）');
    const segments = cuesToSegments(cues);
    const mined = await mineLessonChecked(plugin, segments, 'video');
    const data = buildLessonData({
      title: args.title,
      source: {
        kind: args.media.kind === 'youtube' ? 'youtube' : 'local-media',
        url: args.sourceUrl,
        feedName: args.feedName,
      },
      media: { ...args.media, subtitlePath: args.subtitleFile?.path },
      segments,
      mined,
    });
    notice.hide();
    await finish(plugin, data, args.itemId);
  } catch (e) {
    notice.hide();
    new Notice(`生成失败：${(e as Error).message}`);
  }
}

/** 当前笔记正文 → 教程（本地文档路径）。 */
export async function generateFromNote(plugin: ElpPlugin, file: TFile): Promise<void> {
  if (!plugin.license.checkLessonQuota()) return;
  const raw = await plugin.app.vault.cachedRead(file);
  const text = raw
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[\[[^\]]*\]\]|\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, '$1')
    .replace(/[#>*`]/g, '');
  const segments = textToSegments(text);
  if (segments.length < 3) { new Notice('正文太短'); return; }
  const mined = await mineLessonChecked(plugin, segments, 'article');
  const data = buildLessonData({
    title: file.basename,
    source: { kind: 'note', url: file.path },
    segments,
    mined,
  });
  await finish(plugin, data);
}

async function mineLessonChecked(
  plugin: ElpPlugin, segments: LessonSegment[], kind: 'video' | 'article',
) {
  if (!(await plugin.dict.isReady())) {
    throw new Error('词典索引未构建（设置 → Lexora → 重建索引）');
  }
  return mineLesson(segments, plugin.dict, mineOpts(plugin, kind), excluder(plugin));
}
