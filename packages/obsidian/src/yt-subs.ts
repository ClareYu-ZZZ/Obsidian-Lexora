/**
 * 自动拉取 YouTube 视频自带字幕（人工优先，ASR 自动字幕兜底）：
 * watch 页 → ytInitialPlayerResponse.captions → timedtext baseUrl → vtt。
 * 纯 HTTP，不依赖 yt-dlp。
 */

import { ytGet, ytPost } from './yt-net';
import { extractEmbeddedJson } from '@elp/core';
import type ElpPlugin from './main';

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string; // 'asr' = 自动字幕
}

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
  };
}

export const INVIDIOUS_MIRRORS = ['https://yewtu.be', 'https://inv.nadeko.net', 'https://invidious.nerdvpn.de'];

/** 路线一：官方 watch 页的 captionTracks（新视频的链接常被 pot 校验拦成空响应）。 */
async function fromWatchPage(plugin: ElpPlugin, videoId: string): Promise<string | null> {
  try {
    const page = await ytGet(plugin, `https://www.youtube.com/watch?v=${videoId}&hl=en`);
    if (page.status >= 400) { console.debug('[lexora] watch page', page.status); return null; }
    const pr = extractEmbeddedJson(page.text, 'ytInitialPlayerResponse') as PlayerResponse | null;
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    console.debug('[lexora] caption tracks:', tracks.length);
    if (tracks.length === 0) return null;
    // 英文人工 > 英文自动 > 其他人工 > 其他
    const score = (t: CaptionTrack): number =>
      (t.languageCode?.startsWith('en') ? 2 : 0) + (t.kind === 'asr' ? 0 : 1);
    const best = [...tracks].sort((a, b) => score(b) - score(a))[0];
    if (!best?.baseUrl) return null;
    const sep = best.baseUrl.includes('?') ? '&' : '?';
    const sub = await ytGet(plugin, `${best.baseUrl}${sep}fmt=vtt`);
    console.debug('[lexora] timedtext:', sub.status, sub.text?.length ?? 0);
    if (sub.status >= 400 || !sub.text?.includes('WEBVTT')) return null;
    return sub.text;
  } catch (e) {
    console.debug('[lexora] watch page error', e);
    return null;
  }
}

/** 路线 1.5：Innertube ANDROID 客户端——其字幕直链不吃 pot 校验（yt-dlp 同款）。 */
async function fromInnertube(plugin: ElpPlugin, videoId: string): Promise<string | null> {
  try {
    const r = await ytPost(plugin, 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.50.37',
          androidSdkVersion: 34,
          osName: 'Android', osVersion: '14',
          hl: 'en', gl: 'US',
        },
      },
      videoId,
      contentCheckOk: true, racyCheckOk: true,
    }, { 'user-agent': 'com.google.android.youtube/19.50.37 (Linux; U; Android 14) gzip', 'x-youtube-client-name': '3', 'x-youtube-client-version': '19.50.37' });
    if (r.status >= 400) { console.debug('[lexora] innertube', r.status); return null; }
    let pr: PlayerResponse | null = null;
    try { pr = JSON.parse(r.text) as PlayerResponse; } catch { return null; }
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    console.debug('[lexora] innertube tracks:', tracks.length);
    if (tracks.length === 0) return null;
    const score = (t: CaptionTrack): number =>
      (t.languageCode?.startsWith('en') ? 2 : 0) + (t.kind === 'asr' ? 0 : 1);
    const best = [...tracks].sort((a, b) => score(b) - score(a))[0];
    if (!best?.baseUrl) return null;
    const sep = best.baseUrl.includes('?') ? '&' : '?';
    const sub = await ytGet(plugin, `${best.baseUrl}${sep}fmt=vtt`);
    console.debug('[lexora] innertube timedtext:', sub.status, sub.text?.length ?? 0);
    if (sub.status >= 400 || !sub.text?.includes('WEBVTT')) return null;
    return sub.text;
  } catch (e) {
    console.debug('[lexora] innertube error', e);
    return null;
  }
}

interface InvCaption { label?: string; languageCode?: string; language_code?: string; url?: string }

/** 路线二：Invidious 镜像的字幕 API（服务端已处理校验，直接给 vtt）。 */
async function fromInvidious(plugin: ElpPlugin, videoId: string): Promise<string | null> {
  for (const base of INVIDIOUS_MIRRORS) {
    try {
      const list = await ytGet(plugin, `${base}/api/v1/captions/${videoId}`);
      if (list.status >= 400) continue;
      let caps: InvCaption[] = [];
      try { caps = (JSON.parse(list.text) as { captions?: InvCaption[] }).captions ?? []; } catch { continue; }
      console.debug('[lexora] invidious captions', base, caps.length);
      if (caps.length === 0) continue;
      const score = (c: InvCaption): number => {
        const lang = c.languageCode ?? c.language_code ?? '';
        return (lang.startsWith('en') ? 2 : 0) + (/auto/i.test(c.label ?? '') ? 0 : 1);
      };
      const best = [...caps].sort((a, b) => score(b) - score(a))[0];
      if (!best?.url) continue;
      const url = best.url.startsWith('http') ? best.url : `${base}${best.url}`;
      const sub = await ytGet(plugin, url);
      if (sub.status < 400 && sub.text?.includes('WEBVTT')) return sub.text;
    } catch { /* 下一个镜像 */ }
  }
  return null;
}

/** 返回 vtt 文本；路线：官方页 → Innertube ANDROID（免 pot）→ Invidious → 自托管 worker yt-dlp。 */
export async function fetchYoutubeSubtitle(plugin: ElpPlugin, videoId: string): Promise<string | null> {
  const direct = (await fromWatchPage(plugin, videoId))
    ?? (await fromInnertube(plugin, videoId))
    ?? (await fromInvidious(plugin, videoId));
  if (direct) return direct;
  if (plugin.settings.workerUrl) {
    console.debug('[lexora] trying worker subtitle');
    return plugin.worker.subtitle(videoId);
  }
  return null;
}
