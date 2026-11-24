/**
 * 官方服务（无鉴权公开端点）：推荐源清单 + 公版内容库（精选课）。
 * 均为只读内容分发；失败时静默回退内置数据，绝不打扰用户。
 */
import { Notice, normalizePath, requestUrl } from 'obsidian';
import { generateFromMedia } from './generate';
import type ElpPlugin from './main';

export const OFFICIAL_BASE = 'https://worker.lexora-agent.com';

export interface PresetFeed { name: string; url: string; hint: string }

export interface LibraryFile { name: string; size: number; type: string }
export interface LibraryCollection {
  id: string; title: string; source: string; level: string; desc: string;
  preview: boolean; freeGen: boolean; files: LibraryFile[];
}

const DAY = 86400_000;

/** 同步读缓存（没有或超过 7 天视为无）。 */
export function cachedRecommended(plugin: ElpPlugin): PresetFeed[] | null {
  const c = plugin.settings.officialFeedsCache;
  if (!c || Date.now() - c.at > 7 * DAY || c.feeds.length === 0) return null;
  return c.feeds;
}

/** 后台刷新推荐源缓存（每天最多一次）。 */
export async function refreshRecommended(plugin: ElpPlugin): Promise<void> {
  const c = plugin.settings.officialFeedsCache;
  if (c && Date.now() - c.at < DAY) return;
  try {
    const res = await requestUrl({ url: `${OFFICIAL_BASE}/v1/recommended-feeds`, throw: false });
    const feeds = res.status === 200 ? res.json?.feeds : null;
    if (!Array.isArray(feeds) || feeds.length === 0) return;
    const TYPE_HINT: Record<string, string> = { bilibili: 'B站', rss: '播客', article: '文章' };
    plugin.settings.officialFeedsCache = {
      at: Date.now(),
      feeds: feeds.map((f: { name: string; url: string; group?: string; type?: string }) => ({
        name: String(f.name),
        url: String(f.url),
        hint: f.group || TYPE_HINT[f.type ?? ''] || '推荐',
      })),
    };
    await plugin.saveSettings();
  } catch { /* 静默 */ }
}

export function libraryFileUrl(cid: string, name: string): string {
  return `${OFFICIAL_BASE}/v1/library/${cid}/file/${encodeURIComponent(name)}`;
}

const AUDIO_EXT = new Set(['mp3', 'm4a', 'mp4']);
const SUB_EXT = new Set(['vtt', 'srt']);

interface Episode { stem: string; media: LibraryFile; subtitle?: LibraryFile }

export function episodesOf(col: LibraryCollection): Episode[] {
  const subs = new Map<string, LibraryFile>();
  for (const f of col.files) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (SUB_EXT.has(ext)) subs.set(f.name.replace(/\.[^.]+$/, ''), f);
  }
  const eps: Episode[] = [];
  for (const f of col.files) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!AUDIO_EXT.has(ext)) continue;
    const stem = f.name.replace(/\.[^.]+$/, '');
    eps.push({ stem, media: f, subtitle: subs.get(stem) });
  }
  return eps;
}

/** 渲染「精选课」区块（添加来源弹窗内）。 */
export async function renderLibrarySection(
  plugin: ElpPlugin,
  wrap: HTMLElement,
  onGenerated: () => void,
): Promise<void> {
  let cols: LibraryCollection[] = [];
  try {
    const res = await requestUrl({ url: `${OFFICIAL_BASE}/v1/library`, throw: false });
    if (res.status === 200 && Array.isArray(res.json?.collections)) cols = res.json.collections;
  } catch { /* 下面按空处理 */ }
  wrap.empty();
  if (cols.length === 0) {
    wrap.createDiv({ cls: 'elp-lib-empty', text: '精选课暂未上线，敬请期待' });
    return;
  }
  let player: HTMLAudioElement | null = null;
  let playingBtn: HTMLButtonElement | null = null;
  const stop = () => {
    player?.pause();
    player = null;
    if (playingBtn) { playingBtn.setText('试听'); playingBtn = null; }
  };
  for (const col of cols) {
    const eps = episodesOf(col);
    const row = wrap.createDiv({ cls: 'elp-lib-row' });
    const info = row.createDiv({ cls: 'elp-lib-info' });
    info.createDiv({ cls: 'elp-lib-title', text: col.title });
    info.createDiv({
      cls: 'elp-lib-meta',
      text: `${col.source} · ${col.level} · ${eps.length} 集` + (col.freeGen ? ' · 免费' : ' · Pro'),
    });
    if (col.preview && eps.length > 0) {
      const btn = row.createEl('button', { cls: 'elp-lib-btn', text: '试听' });
      btn.onclick = () => {
        if (playingBtn === btn) { stop(); return; }
        stop();
        player = new Audio(libraryFileUrl(col.id, eps[0].media.name));
        void player.play().catch(() => new Notice('试听加载失败'));
        player.onended = stop;
        playingBtn = btn;
        btn.setText('■ 停止');
      };
    }
    const gen = row.createEl('button', { cls: 'elp-lib-btn is-primary', text: '生成教程' });
    gen.onclick = async () => {
      if (!col.freeGen && !plugin.license.pro) {
        new Notice('该精选课需 Lexora Pro 解锁生成（试听免费）。设置中输入 license key，或先体验 14 天试用。', 8000);
        return;
      }
      const ep = eps[0];
      if (!ep) { new Notice('该合集还没有可生成的音频'); return; }
      if (!ep.subtitle) { new Notice('该集缺少字幕文件，暂不能生成'); return; }
      gen.disabled = true;
      gen.setText('下载中…');
      try {
        const mediaRes = await requestUrl({ url: libraryFileUrl(col.id, ep.media.name) });
        const subRes = await requestUrl({ url: libraryFileUrl(col.id, ep.subtitle.name) });
        const dir = normalizePath(`${plugin.settings.lessonsFolder}/_library/${col.title}`);
        if (!plugin.app.vault.getAbstractFileByPath(dir)) {
          await plugin.app.vault.createFolder(dir).catch(() => undefined);
        }
        const mediaPath = `${dir}/${ep.media.name}`;
        if (!plugin.app.vault.getAbstractFileByPath(mediaPath)) {
          await plugin.app.vault.createBinary(mediaPath, mediaRes.arrayBuffer);
        }
        stop();
        onGenerated();
        await generateFromMedia(plugin, {
          title: `${col.title} · ${ep.stem}`,
          media: { kind: 'local', path: mediaPath },
          subtitleText: subRes.text,
        });
      } catch (e) {
        new Notice(`生成失败:${(e as Error).message}`);
      } finally {
        gen.disabled = false;
        gen.setText('生成教程');
      }
    };
  }
}
