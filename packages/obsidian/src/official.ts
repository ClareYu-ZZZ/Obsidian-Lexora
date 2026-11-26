/**
 * 官方服务（无鉴权公开端点）：推荐源清单 + 公版内容库（精选课）。
 * 均为只读内容分发；失败时静默回退内置数据，绝不打扰用户。
 */
import { Notice, normalizePath, requestUrl } from 'obsidian';
import { generateFromMedia } from './generate';
import type ElpPlugin from './main';

export const OFFICIAL_BASE = 'https://worker.lexora-agent.com';

export interface PresetFeed { name: string; url: string; hint: string; region?: 'cn' | 'global' }

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

/** 刷新推荐源缓存。打开订阅弹窗时调用（10 分钟节流），控制台「保存并发布」后用户下次打开即可见。
 *  返回清单是否有变化（供调用方决定要不要重渲染）。 */
export async function refreshRecommended(plugin: ElpPlugin): Promise<boolean> {
  const c = plugin.settings.officialFeedsCache;
  if (c && Date.now() - c.at < 10 * 60_000) return false;
  try {
    const res = await requestUrl({ url: `${OFFICIAL_BASE}/v1/recommended-feeds`, throw: false });
    const feeds = res.status === 200 ? res.json?.feeds : null;
    if (!Array.isArray(feeds) || feeds.length === 0) return false;
    const TYPE_HINT: Record<string, string> = { bilibili: 'B站', rss: '播客', article: '文章', youtube: 'YouTube' };
    plugin.settings.officialFeedsCache = {
      at: Date.now(),
      feeds: feeds.map((f: { name: string; url: string; group?: string; type?: string; region?: string }) => ({
        name: String(f.name),
        url: String(f.url),
        hint: f.group || TYPE_HINT[f.type ?? ''] || '推荐',
        // 未标注 region 的旧数据：YouTube 地址视为境外，其余国内直连
        region: (f.region === 'global' || f.region === 'cn')
          ? f.region
          : (/youtube\.com|youtu\.be/.test(String(f.url)) ? 'global' as const : 'cn' as const),
      })),
    };
    const changed = JSON.stringify(plugin.settings.officialFeedsCache.feeds) !== JSON.stringify(c?.feeds ?? null);
    await plugin.saveSettings();
    return changed;
  } catch { /* 静默 */ }
  return false;
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

  // 单实例试听播放器（带细进度条）
  let player: HTMLAudioElement | null = null;
  let playingKey = '';
  let cleanup: (() => void) | null = null;
  const stop = () => {
    player?.pause();
    player = null;
    playingKey = '';
    cleanup?.();
    cleanup = null;
  };

  const expanded = new Set<string>([cols[0].id]);

  const render = () => {
    stop();
    wrap.empty();
    for (const col of cols) {
      const eps = episodesOf(col);
      const box = wrap.createDiv({ cls: 'elp-libx' });
      const head = box.createDiv({ cls: 'elp-libx-head' });
      head.createDiv({ cls: 'elp-libx-icon', text: '📖' });
      const info = head.createDiv({ cls: 'elp-libx-info' });
      const tl = info.createDiv({ cls: 'elp-libx-titleline' });
      tl.createSpan({ cls: 'elp-libx-title', text: col.title });
      tl.createSpan({ cls: 'elp-tag', text: col.level });
      tl.createSpan({ cls: 'elp-tag' + (col.freeGen ? ' is-done' : ' is-pro'), text: col.freeGen ? '免费生成' : '生成需 Pro' });
      info.createDiv({ cls: 'elp-libx-meta', text: `${col.source} · ${eps.length} 集 · 公有领域` });
      head.createSpan({ cls: 'elp-libx-fold', text: expanded.has(col.id) ? '▲ 收起' : '▼ 展开' });
      head.onclick = () => {
        if (expanded.has(col.id)) expanded.delete(col.id);
        else expanded.add(col.id);
        render();
      };
      if (!expanded.has(col.id)) continue;

      const list = box.createDiv({ cls: 'elp-libx-list' });
      eps.forEach((ep, i) => {
        const row = list.createDiv({ cls: 'elp-libx-ep' });
        row.createSpan({ cls: 'elp-libx-no', text: String(i + 1).padStart(2, '0') });
        const mid = row.createDiv({ cls: 'elp-libx-epmid' });
        mid.createDiv({ cls: 'elp-libx-epname', text: ep.stem });
        const barWrap = mid.createDiv({ cls: 'elp-libx-bar is-hidden' });
        const bar = barWrap.createDiv({ cls: 'elp-libx-bar-fill' });

        if (col.preview) {
          const key = `${col.id}/${ep.stem}`;
          const listenBtn = row.createEl('button', { cls: 'elp-lib-btn', text: playingKey === key ? '⏸ 停止' : '▶ 试听' });
          listenBtn.onclick = (e) => {
            e.stopPropagation();
            if (playingKey === key) { stop(); listenBtn.setText('▶ 试听'); barWrap.addClass('is-hidden'); return; }
            stop();
            render(); // 复位其它行
          };
          if (playingKey !== key) {
            listenBtn.onclick = (e) => {
              e.stopPropagation();
              stop();
              player = new Audio(libraryFileUrl(col.id, ep.media.name));
              void player.play().catch(() => new Notice('试听加载失败'));
              playingKey = key;
              listenBtn.setText('⏸ 停止');
              barWrap.removeClass('is-hidden');
              const au = player;
              const onT = () => { if (au.duration) bar.style.width = `${(au.currentTime / au.duration) * 100}%`; };
              au.addEventListener('timeupdate', onT);
              au.onended = () => { stop(); listenBtn.setText('▶ 试听'); barWrap.addClass('is-hidden'); };
              cleanup = () => {
                au.removeEventListener('timeupdate', onT);
                listenBtn.setText('▶ 试听');
                barWrap.addClass('is-hidden');
                bar.style.width = '0%';
              };
            };
          }
        }

        const gen = row.createEl('button', { cls: 'elp-lib-btn is-primary', text: '生成教程' });
        gen.onclick = async (e) => {
          e.stopPropagation();
          if (!col.freeGen && !plugin.license.pro) {
            new Notice('该精选课需 Lexora Pro 解锁生成（试听免费）。设置中输入 license key，或先体验 14 天试用。', 8000);
            return;
          }
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
          } catch (e2) {
            new Notice(`生成失败:${(e2 as Error).message}`);
          } finally {
            gen.disabled = false;
            gen.setText('生成教程');
          }
        };
      });
    }
  };
  render();
}
