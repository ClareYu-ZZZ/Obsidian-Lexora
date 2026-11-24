/**
 * Bilibili 订阅支持：UP 主视频列表（wbi 签名）+ CC 字幕 → VTT。
 * 全部请求发生在用户本机；SESSDATA（可选）只存本地 data.json，仅用于拉字幕。
 * 不做任何视频/音频下载——播放走 player.bilibili.com 官方内嵌。
 */
import { Platform, requestUrl } from 'obsidian';
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

interface BiliResp { status: number; text: string }

/**
 * 桌面端用 Node https 直连——完全绕开 Chromium 网络栈，
 * 免疫 ERR_BLOCKED_BY_CLIENT 这类进程内拦截器；移动端回退 requestUrl。
 */
function biliGet(url: string, headers: Record<string, string>): Promise<BiliResp> {
  const req = (window as Window & { require?: (m: string) => unknown }).require;
  if (Platform.isDesktopApp && req) {
    const https = req('https') as typeof import('https');
    return new Promise((resolve, reject) => {
      const r = https.get(url, { headers: { ...headers, 'accept-encoding': 'identity' }, timeout: 15000 }, (res) => {
        if (res.statusCode && res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
          biliGet(new URL(res.headers.location, url).toString(), headers).then(resolve, reject);
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      r.on('timeout', () => { r.destroy(new Error('timeout')); });
      r.on('error', reject);
    });
  }
  return requestUrl({ url, headers, throw: false }).then((r) => ({ status: r.status, text: r.text }));
}

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

async function biliHeaders(plugin: ElpPlugin, withSession = true): Promise<Record<string, string>> {
  if (!buvidCache) {
    try {
      const r = await biliGet('https://api.bilibili.com/x/frontend/finger/spi', { 'user-agent': UA });
      const j = safeJson(r) as { data?: { b_3?: string; b_4?: string } } | null;
      const d = j?.data;
      if (d?.b_3) buvidCache = `buvid3=${d.b_3}` + (d.b_4 ? `; buvid4=${d.b_4}` : '');
    } catch { /* 下面兜底 */ }
    if (!buvidCache) {
      const rand = () => Math.random().toString(16).slice(2).toUpperCase();
      buvidCache = `buvid3=${rand()}${rand()}${rand()}infoc`.slice(0, 48);
    }
  }
  const cookies: string[] = [];
  if (buvidCache) cookies.push(buvidCache);
  const sess = plugin.settings.bilibiliSessdata?.trim();
  if (withSession && sess) cookies.push(`SESSDATA=${sess}`);
  const h: Record<string, string> = { 'user-agent': UA, referer: 'https://www.bilibili.com/', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' };
  if (cookies.length) h.cookie = cookies.join('; ');
  return h;
}

async function wbiKey(plugin: ElpPlugin): Promise<string> {
  if (wbiCache && Date.now() - wbiCache.at < 6 * 3600_000) return wbiCache.key;
  const r = await biliGet('https://api.bilibili.com/x/web-interface/nav', await biliHeaders(plugin));
  const j = safeJson(r) as { data?: { wbi_img?: { img_url: string; sub_url: string } } } | null;
  if (!j) { diag('nav', `HTML@${r.status}`); throw htmlBlockError(r.status); }
  diag('nav', 'ok');
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
  const r = await biliGet(`https://api.bilibili.com/x/space/wbi/arc/search?${q}`, { ...(await biliHeaders(plugin)), referer: `https://space.bilibili.com/${mid}/video` });
  const j = safeJson(r) as {
    code?: number;
    data?: { list?: { vlist?: Array<{ bvid: string; title: string; created: number; pic?: string; author?: string; description?: string; length?: string }> } };
  } | null;
  if (!j) { diag('arc', `HTML@${r.status}`); return null; }
  if (j.code !== 0) { diag('arc', `code=${j.code}`); return null; }
  const vlist = j.data?.list?.vlist ?? [];
  if (vlist.length === 0) { diag('arc', 'empty'); return null; }
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
  const r = await biliGet(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${q}`, { ...(await biliHeaders(plugin, true)), referer: `https://space.bilibili.com/${mid}/dynamic` });
  const j = safeJson(r) as {
    code?: number;
    data?: { items?: Array<{ modules?: { module_author?: { name?: string; pub_ts?: number }; module_dynamic?: { major?: { archive?: { bvid?: string; title?: string; cover?: string; desc?: string; duration_text?: string } } } } }> };
  } | null;
  if (!j) { diag('dyn', `HTML@${r.status}`); return null; }
  if (j.code !== 0) { diag('dyn', `code=${j.code}`); return null; }
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

export const biliDiag: string[] = [];

export function diag(step: string, info: string): void {
  biliDiag.push(`${step}:${info}`);
  if (biliDiag.length > 8) biliDiag.shift();
}

/** UP 主最近投稿：投稿列表接口优先，动态流兜底。 */
export async function fetchSpaceFeed(plugin: ElpPlugin, mid: string): Promise<ParsedFeed> {
  biliDiag.length = 0;
  const a = await fetchByArcSearch(plugin, mid).catch((e: Error) => { diag('arc', e.message.slice(0, 60)); return null; });
  if (a) return a;
  const b = await fetchByDynamics(plugin, mid).catch((e: Error) => { diag('dyn', e.message.slice(0, 60)); return null; });
  if (b) return b;
  throw new Error(`B 站接口被风控拦截。诊断：${biliDiag.join(' | ') || '无'}。稍后重试或换网络`);
}

async function fetchCid(plugin: ElpPlugin, bvid: string): Promise<number> {
  const r = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, await biliHeaders(plugin));
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
  const r = await biliGet(`https://api.bilibili.com/x/player/wbi/v2?${q}`, await biliHeaders(plugin, true));
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
  const subRes = await biliGet(url, await biliHeaders(plugin));
  const subJson = safeJson(subRes) as { body?: Array<{ from: number; to: number; content: string }> } | null;
  const body: Array<{ from: number; to: number; content: string }> = subJson?.body ?? [];
  if (body.length === 0) return null;
  const cues = body.map(
    (c, i) => `${i + 1}\n${sec2ts(c.from)} --> ${sec2ts(c.to)}\n${c.content.trim()}\n`,
  );
  return `WEBVTT\n\n${cues.join('\n')}`;
}
