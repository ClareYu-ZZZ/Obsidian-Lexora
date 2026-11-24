/**
 * YouTube 直连通道：与 bilibili.ts 的 biliGet 同模式——桌面端走 Node https，
 * 完全绕开 Chromium 网络栈（免疫进程内拦截器）；移动端回退 requestUrl。
 * 用户自己的 Cookie 只附在 *.youtube.com 请求上，绝不发给镜像站或任何 worker。
 */
import { Platform, requestUrl } from 'obsidian';
import type ElpPlugin from './main';

interface YtResp { status: number; text: string }

const UA_HEADERS = { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en' };

function isYoutubeHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'youtube.com' || h.endsWith('.youtube.com') || h.endsWith('.googlevideo.com');
  } catch { return false; }
}

export function ytGet(plugin: ElpPlugin, url: string, timeoutMs = 15000): Promise<YtResp> {
  const headers: Record<string, string> = { ...UA_HEADERS, 'accept-encoding': 'identity' };
  const cookie = plugin.settings.youtubeCookie?.trim();
  if (cookie && isYoutubeHost(url)) headers.cookie = cookie;
  const req = (window as Window & { require?: (m: string) => unknown }).require;
  if (Platform.isDesktopApp && req) {
    const https = req('https') as typeof import('https');
    return new Promise((resolve, reject) => {
      const r = https.get(url, { headers, timeout: timeoutMs }, (res) => {
        if (res.statusCode && res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
          ytGet(plugin, new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
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

// ---------- 境外网络探测 ----------
let overseas: boolean | null = null;
let probing: Promise<boolean> | null = null;
let probedAt = 0;

/** 同步读取上次探测结果；null = 还没探测过/探测中。 */
export function overseasState(): boolean | null { return overseas; }

/** 探测本机网络能否直达 YouTube（generate_204，4 秒超时），结果缓存 30 分钟。 */
export function probeOverseas(plugin: ElpPlugin, force = false): Promise<boolean> {
  if (!force && overseas !== null && Date.now() - probedAt < 30 * 60_000) return Promise.resolve(overseas);
  if (probing) return probing;
  probing = ytGet(plugin, 'https://www.youtube.com/generate_204', 4000)
    .then((r) => r.status > 0 && r.status < 400)
    .catch(() => false)
    .then((ok) => {
      overseas = ok;
      probedAt = Date.now();
      probing = null;
      return ok;
    });
  return probing;
}
