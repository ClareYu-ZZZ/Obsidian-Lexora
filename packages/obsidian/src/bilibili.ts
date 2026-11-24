/**
 * Bilibili 订阅支持：UP 主视频列表（wbi 签名）+ CC 字幕 → VTT。
 * 全部请求发生在用户本机；SESSDATA（可选）只存本地 data.json，仅用于拉字幕。
 * 不做任何视频/音频下载——播放走 player.bilibili.com 官方内嵌。
 */
import { requestUrl } from 'obsidian';
import { md5 } from 'js-md5';
import type { ParsedFeed } from '@elp/core';
import type ElpPlugin from './main';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** wbi mixin 置换表（B 站 2023 起的公开签名算法，社区长期维护）。 */
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

let wbiCache: { key: string; at: number } | null = null;
let buvidCache: string | null = null;

async function biliHeaders(plugin: ElpPlugin, withSession = false): Promise<Record<string, string>> {
  if (!buvidCache) {
    try {
      const r = await requestUrl({
        url: 'https://api.bilibili.com/x/frontend/finger/spi',
        headers: { 'user-agent': UA },
        throw: false,
      });
      const d = r.json?.data;
      if (d?.b_3) buvidCache = `buvid3=${d.b_3}` + (d.b_4 ? `; buvid4=${d.b_4}` : '');
    } catch { /* 无 buvid 也先试 */ }
  }
  const cookies: string[] = [];
  if (buvidCache) cookies.push(buvidCache);
  const sess = plugin.settings.bilibiliSessdata?.trim();
  if (withSession && sess) cookies.push(`SESSDATA=${sess}`);
  const h: Record<string, string> = { 'user-agent': UA, referer: 'https://www.bilibili.com/' };
  if (cookies.length) h.cookie = cookies.join('; ');
  return h;
}

async function wbiKey(plugin: ElpPlugin): Promise<string> {
  if (wbiCache && Date.now() - wbiCache.at < 6 * 3600_000) return wbiCache.key;
  const r = await requestUrl({
    url: 'https://api.bilibili.com/x/web-interface/nav',
    headers: await biliHeaders(plugin),
    throw: false,
  });
  const img = r.json?.data?.wbi_img;
  if (!img?.img_url) throw new Error('wbi 密钥获取失败');
  const take = (u: string) => u.slice(u.lastIndexOf('/') + 1).split('.')[0];
  const raw = take(img.img_url) + take(img.sub_url);
  const key = MIXIN.map((i) => raw[i]).join('').slice(0, 32);
  wbiCache = { key, at: Date.now() };
  return key;
}

async function wbiSign(plugin: ElpPlugin, params: Record<string, string | number>): Promise<string> {
  const key = await wbiKey(plugin);
  const all: Record<string, string | number> = { ...params, wts: Math.floor(Date.now() / 1000) };
  const qs = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${qs}&w_rid=${md5(qs + key)}`;
}

export function parseBilibiliSpace(url: string): string | null {
  const m = url.match(/space\.bilibili\.com\/(\d+)/);
  return m ? m[1] : null;
}

export function bilibiliWatchUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`;
}

/** UP 主最近投稿 → ParsedFeed（标题=UP 主名）。 */
export async function fetchSpaceFeed(plugin: ElpPlugin, mid: string): Promise<ParsedFeed> {
  const q = await wbiSign(plugin, { mid, ps: 25, pn: 1, order: 'pubdate' });
  const r = await requestUrl({
    url: `https://api.bilibili.com/x/space/wbi/arc/search?${q}`,
    headers: await biliHeaders(plugin),
    throw: false,
  });
  const code = r.json?.code;
  if (code !== 0) {
    const hint = code === -352 ? '（触发风控，稍后重试）' : '';
    throw new Error(`B站接口 ${code ?? r.status}${hint}`);
  }
  const vlist: Array<{
    bvid: string; title: string; created: number; pic?: string; author?: string; description?: string; length?: string;
  }> = r.json.data?.list?.vlist ?? [];
  const author = vlist[0]?.author || `UP主 ${mid}`;
  return {
    title: author,
    kind: 'bilibili',
    items: vlist.map((v) => ({
      id: `bili-${v.bvid}`,
      title: v.title,
      link: bilibiliWatchUrl(v.bvid),
      published: new Date(v.created * 1000).toISOString(),
      bvid: v.bvid,
      image: v.pic?.startsWith('//') ? `https:${v.pic}` : v.pic,
      summary: [v.length, v.description].filter(Boolean).join(' · ') || undefined,
    })),
  };
}

async function fetchCid(plugin: ElpPlugin, bvid: string): Promise<number> {
  const r = await requestUrl({
    url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    headers: await biliHeaders(plugin),
    throw: false,
  });
  const cid = r.json?.data?.cid;
  if (!cid) throw new Error(`视频信息获取失败（${r.json?.code ?? r.status}）`);
  return cid;
}

function sec2ts(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
}

/** 拉 CC 字幕并转 VTT；没有返回 null。英文轨优先，人工轨优先于 AI 轨。 */
export async function fetchBiliSubtitleVtt(plugin: ElpPlugin, bvid: string): Promise<string | null> {
  const cid = await fetchCid(plugin, bvid);
  const q = await wbiSign(plugin, { bvid, cid });
  const r = await requestUrl({
    url: `https://api.bilibili.com/x/player/wbi/v2?${q}`,
    headers: await biliHeaders(plugin, true),
    throw: false,
  });
  const subs: Array<{ lan: string; subtitle_url?: string }> = r.json?.data?.subtitle?.subtitles ?? [];
  const usable = subs.filter((s) => s.subtitle_url);
  if (usable.length === 0) return null;
  const pick =
    usable.find((s) => /^en/.test(s.lan) && !s.lan.startsWith('ai')) ??
    usable.find((s) => /en/.test(s.lan)) ??
    usable.find((s) => !s.lan.startsWith('ai')) ??
    usable[0];
  let url = pick.subtitle_url!;
  if (url.startsWith('//')) url = `https:${url}`;
  const body: Array<{ from: number; to: number; content: string }> =
    (await requestUrl({ url, headers: await biliHeaders(plugin), throw: false })).json?.body ?? [];
  if (body.length === 0) return null;
  const cues = body.map(
    (c, i) => `${i + 1}\n${sec2ts(c.from)} --> ${sec2ts(c.to)}\n${c.content.trim()}\n`,
  );
  return `WEBVTT\n\n${cues.join('\n')}`;
}
