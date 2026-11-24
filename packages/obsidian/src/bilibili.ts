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

function safeJson(r: { text: string }): Record<string, unknown> | null {
  try {
    const v = JSON.parse(r.text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function htmlBlockError(status: number): Error {
  return new Error(`B 站返回了网页而非数据（HTTP ${status}，疑似风控或地区拦截）。稍后重试；若持续，设置 → Bilibili 填入 SESSDATA 通常可解`);
}

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
      const j = safeJson(r) as { data?: { b_3?: string; b_4?: string } } | null;
      const d = j?.data;
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
  const j = safeJson(r) as { data?: { wbi_img?: { img_url: string; sub_url: string } } } | null;
  if (!j) throw htmlBlockError(r.status);
  const img = j.data?.wbi_img;
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
  // 兼容带语言段的链接：space.bilibili.com/en/123、/zh-Hant/123 等
  const m = url.match(/space\.bilibili\.com\/(?:[A-Za-z]{2}(?:-[A-Za-z]{2,4})?\/)?(\d+)/);
  return m ? m[1] : null;
}

export function bilibiliWatchUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`;
}

/** UP 主最近投稿 → ParsedFeed（标题=UP 主名）。 */
// arc/search 的风控还要求一组 WebGL 指纹参数（社区验证的固定值即可）
const DM_PARAMS = {
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str: 'QU5HTEUgKEFwcGxlLCBBTkdMRSBNZXRhbCBSZW5kZXJlcjogQXBwbGUgTTEsIFVuc3BlY2lmaWVkIFZlcnNpb24p',
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
};

async function fetchByArcSearch(plugin: ElpPlugin, mid: string): Promise<ParsedFeed | null> {
  const q = await wbiSign(plugin, { mid, ps: 25, pn: 1, order: 'pubdate', ...DM_PARAMS });
  const r = await requestUrl({
    url: `https://api.bilibili.com/x/space/wbi/arc/search?${q}`,
    headers: { ...(await biliHeaders(plugin)), referer: `https://space.bilibili.com/${mid}/video` },
    throw: false,
  });
  const j = safeJson(r) as {
    code?: number;
    data?: { list?: { vlist?: Array<{ bvid: string; title: string; created: number; pic?: string; author?: string; description?: string; length?: string }> } };
  } | null;
  if (!j || j.code !== 0) return null;
  const vlist = j.data?.list?.vlist ?? [];
  if (vlist.length === 0) return null;
  return {
    title: vlist[0]?.author || `UP主 ${mid}`,
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

/** 兜底：动态流接口（风控阈值不同，常在 arc/search 被拦时仍可用）。 */
async function fetchByDynamics(plugin: ElpPlugin, mid: string): Promise<ParsedFeed | null> {
  const q = await wbiSign(plugin, { host_mid: mid, offset: '', timezone_offset: -480 });
  const r = await requestUrl({
    url: `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${q}`,
    headers: { ...(await biliHeaders(plugin, true)), referer: `https://space.bilibili.com/${mid}/dynamic` },
    throw: false,
  });
  const j = safeJson(r) as {
    code?: number;
    data?: { items?: Array<{ modules?: { module_author?: { name?: string; pub_ts?: number }; module_dynamic?: { major?: { archive?: { bvid?: string; title?: string; cover?: string; desc?: string; duration_text?: string } } } } }> };
  } | null;
  if (!j || j.code !== 0) return null;
  const out: ParsedFeed = { title: '', kind: 'bilibili', items: [] };
  for (const it of j.data?.items ?? []) {
    const a = it.modules?.module_dynamic?.major?.archive;
    if (!a?.bvid) continue;
    const author = it.modules?.module_author;
    if (!out.title && author?.name) out.title = author.name;
    out.items.push({
      id: `bili-${a.bvid}`,
      title: a.title ?? a.bvid,
      link: bilibiliWatchUrl(a.bvid),
      published: author?.pub_ts ? new Date(author.pub_ts * 1000).toISOString() : undefined,
      bvid: a.bvid,
      image: a.cover?.startsWith('//') ? `https:${a.cover}` : a.cover,
      summary: [a.duration_text, a.desc].filter(Boolean).join(' · ') || undefined,
    });
  }
  if (out.items.length === 0) return null;
  out.title = out.title || `UP主 ${mid}`;
  return out;
}

/** UP 主最近投稿：投稿列表接口优先，动态流兜底。 */
export async function fetchSpaceFeed(plugin: ElpPlugin, mid: string): Promise<ParsedFeed> {
  const a = await fetchByArcSearch(plugin, mid).catch(() => null);
  if (a) return a;
  const b = await fetchByDynamics(plugin, mid).catch(() => null);
  if (b) return b;
  throw new Error('B 站接口被风控拦截（两条链路均失败）。稍后重试；设置 → Bilibili 填 SESSDATA 通常可解');
}

async function fetchCid(plugin: ElpPlugin, bvid: string): Promise<number> {
  const r = await requestUrl({
    url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    headers: await biliHeaders(plugin),
    throw: false,
  });
  const j = safeJson(r) as { code?: number; data?: { cid?: number } } | null;
  const cid = j?.data?.cid;
  if (!cid) throw new Error(`视频信息获取失败（${j?.code ?? r.status}）`);
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
  const j = safeJson(r) as { data?: { subtitle?: { subtitles?: Array<{ lan: string; subtitle_url?: string }> } } } | null;
  const subs: Array<{ lan: string; subtitle_url?: string }> = j?.data?.subtitle?.subtitles ?? [];
  const usable = subs.filter((s) => s.subtitle_url);
  if (usable.length === 0) return null;
  const pick =
    usable.find((s) => /^en/.test(s.lan) && !s.lan.startsWith('ai')) ??
    usable.find((s) => /en/.test(s.lan)) ??
    usable.find((s) => !s.lan.startsWith('ai')) ??
    usable[0];
  let url = pick.subtitle_url!;
  if (url.startsWith('//')) url = `https:${url}`;
  const subRes = await requestUrl({ url, headers: await biliHeaders(plugin), throw: false });
  const subJson = safeJson(subRes) as { body?: Array<{ from: number; to: number; content: string }> } | null;
  const body: Array<{ from: number; to: number; content: string }> = subJson?.body ?? [];
  if (body.length === 0) return null;
  const cues = body.map(
    (c, i) => `${i + 1}\n${sec2ts(c.from)} --> ${sec2ts(c.to)}\n${c.content.trim()}\n`,
  );
  return `WEBVTT\n\n${cues.join('\n')}`;
}
