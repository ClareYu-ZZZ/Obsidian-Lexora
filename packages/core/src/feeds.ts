/** RSS 2.0 / Atom feed parsing (covers YouTube channel feeds). */

import { attrOf, blocks, tagText } from './xml';

function audioUrlOf(itemXml: string): string | undefined {
  const encUrl = attrOf(itemXml, 'enclosure', 'url');
  const encType = attrOf(itemXml, 'enclosure', 'type');
  if (encUrl && (encType.startsWith('audio') || /\.(mp3|m4a|aac|ogg)(\?|$)/i.test(encUrl))) return encUrl;
  const mediaUrl = attrOf(itemXml, 'media:content', 'url');
  const mediaType = attrOf(itemXml, 'media:content', 'type');
  if (mediaUrl && (mediaType.startsWith('audio') || /\.(mp3|m4a|aac|ogg)(\?|$)/i.test(mediaUrl))) return mediaUrl;
  return undefined;
}

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  published?: string;     // ISO
  videoId?: string;       // YouTube only
  bvid?: string;          // Bilibili only
  summary?: string;       // plain-ish text
  contentHtml?: string;   // full html when the feed carries it
  /** Episode audio (RSS enclosure / media:content), e.g. BBC 6 Minute mp3. */
  audioUrl?: string;
  /** Cover image (media:thumbnail / itunes:image / enclosure / first <img>). */
  image?: string;
  /** 相对时间文本（如 "2 days ago"），来自频道页抓取（无精确日期时用）。 */
  publishedText?: string;
}

function imageOf(itemXml: string, videoId?: string, contentHtml?: string): string | undefined {
  if (videoId) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const thumb = attrOf(itemXml, 'media:thumbnail', 'url');
  if (thumb) return thumb;
  const itunes = attrOf(itemXml, 'itunes:image', 'href');
  if (itunes) return itunes;
  const encUrl = attrOf(itemXml, 'enclosure', 'url');
  if (encUrl && attrOf(itemXml, 'enclosure', 'type').startsWith('image')) return encUrl;
  const mediaUrl = attrOf(itemXml, 'media:content', 'url');
  const mediaType = attrOf(itemXml, 'media:content', 'type');
  if (mediaUrl && (mediaType.startsWith('image') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(mediaUrl))) return mediaUrl;
  const img = (contentHtml ?? '').match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img && /^https?:/.test(img[1])) return img[1];
  return undefined;
}

export type FeedKind = 'youtube' | 'bilibili' | 'article';

export interface ParsedFeed {
  title: string;
  kind: FeedKind;
  items: FeedItem[];
}

export interface FeedConfig {
  id: string;
  name: string;
  url: string;
  kind: FeedKind;
}

function toIso(s: string): string | undefined {
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed[\s>]/.test(xml) && !/<rss[\s>]/.test(xml);
  const items: FeedItem[] = [];

  if (isAtom) {
    const feedHead = xml.split(/<entry[\s>]/)[0] ?? xml;
    const title = tagText(feedHead, 'title');
    for (const entry of blocks(xml, 'entry')) {
      const videoId = tagText(entry, 'yt:videoId') || undefined;
      const link = attrOf(entry, 'link', 'href') || tagText(entry, 'link');
      const id = tagText(entry, 'id') || link;
      if (!id) continue;
      const contentHtml = blocks(entry, 'content')[0];
      items.push({
        id,
        title: tagText(entry, 'title'),
        link,
        published: toIso(tagText(entry, 'published') || tagText(entry, 'updated')),
        videoId,
        summary: tagText(entry, 'media:description') || tagText(entry, 'summary') || undefined,
        contentHtml,
        image: imageOf(entry, videoId, contentHtml),
      });
    }
    return { title, kind: items.some((i) => i.videoId) ? 'youtube' : 'article', items };
  }

  const channelHead = xml.split(/<item[\s>]/)[0] ?? xml;
  const title = tagText(channelHead, 'title');
  for (const item of blocks(xml, 'item')) {
    const link = tagText(item, 'link');
    const id = tagText(item, 'guid') || link;
    if (!id) continue;
    const contentHtml = blocks(item, 'content:encoded')[0] ?? blocks(item, 'description')[0];
    items.push({
      id,
      title: tagText(item, 'title'),
      link,
      published: toIso(tagText(item, 'pubDate') || tagText(item, 'dc:date')),
      summary: tagText(item, 'description') || undefined,
      contentHtml,
      audioUrl: audioUrlOf(item),
      image: imageOf(item, undefined, contentHtml),
    });
  }
  return { title, kind: 'article', items };
}

/** 从 HTML 里按花括号配平抽出 marker 后面的 JSON 对象（ytInitialData / ytInitialPlayerResponse 等）。 */
export function extractEmbeddedJson(html: string, marker: string): unknown {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * YouTube 的 videos.xml RSS 端点失效时的兜底：直接解析频道 /videos 页的
 * ytInitialData，抽出视频列表。
 */
export function parseYoutubeChannelPage(html: string): ParsedFeed {
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  const data = extractEmbeddedJson(html, 'ytInitialData');

  const push = (vid: string, title: string, publishedText?: string): void => {
    if (seen.has(vid) || !title) return;
    seen.add(vid);
    items.push({
      id: `yt:video:${vid}`,
      title,
      link: youtubeWatchUrl(vid),
      videoId: vid,
      image: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      publishedText,
    });
  };

  const walk = (o: unknown): void => {
    if (items.length >= 30) return;
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (!o || typeof o !== 'object') return;
    const r = o as Record<string, unknown>;

    // 旧结构：videoRenderer / gridVideoRenderer
    const vid = r.videoId;
    const title = r.title as { runs?: Array<{ text: string }>; simpleText?: string } | undefined;
    if (typeof vid === 'string' && /^[\w-]{11}$/.test(vid) && title && (title.runs || title.simpleText) && r.thumbnail) {
      push(
        vid,
        title.simpleText ?? title.runs?.map((x) => x.text).join('') ?? '',
        (r.publishedTimeText as { simpleText?: string } | undefined)?.simpleText,
      );
    }

    // 新结构（2025+）：lockupViewModel { contentId, metadata.lockupMetadataViewModel.title.content }
    const cid = r.contentId;
    if (typeof cid === 'string' && /^[\w-]{11}$/.test(cid) && r.metadata && typeof r.metadata === 'object') {
      const meta = (r.metadata as { lockupMetadataViewModel?: { title?: { content?: string } } }).lockupMetadataViewModel;
      const t = meta?.title?.content;
      if (typeof t === 'string' && t) {
        const ago = JSON.stringify(r.metadata).match(/"content":"((?:\d+|a|an) [a-z]+ ago)"/i);
        push(cid, t, ago?.[1]);
      }
    }

    for (const v of Object.values(r)) walk(v);
  };
  walk(data);

  const channelTitle = html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/)?.[1]
    ?? html.match(/<meta property="og:title" content="([^"]+)"/)?.[1]
    ?? '';
  return { title: channelTitle, kind: 'youtube', items };
}

/** Normalize a user-pasted URL into a subscribable feed URL. */
export function normalizeFeedUrl(input: string): string {
  const url = input.trim();
  const channel = url.match(/youtube\.com\/channel\/(UC[\w-]{10,})/);
  if (channel) return `https://www.youtube.com/feeds/videos.xml?channel_id=${channel[1]}`;
  const already = url.match(/youtube\.com\/feeds\/videos\.xml\?channel_id=UC[\w-]{10,}/);
  if (already) return url;
  return url;
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function extractVideoId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}
