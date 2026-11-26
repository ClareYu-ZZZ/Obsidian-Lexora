import { MarkdownView, Notice, Platform, TFile, normalizePath, setIcon } from 'obsidian';
import type { LessonData } from '@elp/core';
import { fmtTime, paraRanges } from '@elp/core';
import type ElpPlugin from './main';
import { iconButton } from './ui';
import { pronounce, stopPronounce } from './audio';
import { downloadBiliStream } from './bilibili';
import { openPlayerPane } from './player-pane';

export async function loadLessonData(plugin: ElpPlugin, mdPath: string): Promise<LessonData | null> {
  const dir = mdPath.split('/').slice(0, -1).join('/');
  const raw = await plugin.storage.readText(`${dir}/lesson.json`);
  if (!raw) return null;
  try { return JSON.parse(raw) as LessonData; } catch { return null; }
}

/** 由 DOM 元素反查它属于哪个 markdown 文件（兼容阅读/实时预览）。 */
function pathForElement(plugin: ElpPlugin, el: HTMLElement): string | null {
  for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.containerEl.contains(el)) {
      return view.file?.path ?? null;
    }
  }
  return plugin.app.workspace.getActiveFile()?.path ?? null;
}

async function handleJump(plugin: ElpPlugin, span: HTMLElement, segIdx: number, segEnd?: number): Promise<void> {
  const path = pathForElement(plugin, span);
  if (!path) return;
  const data = await loadLessonData(plugin, path);
  if (!data) return;
  const pane = await openPlayerPane(plugin);
  pane?.showLesson(path, data, segIdx, segEnd);
}

export function registerPlayer(plugin: ElpPlugin): void {
  // ---- ```lexora-player``` 代码块 → 一条打开播放器面板的横幅 ----
  plugin.registerMarkdownCodeBlockProcessor('lexora-player', async (_src, el, ctx) => {
    const data = await loadLessonData(plugin, ctx.sourcePath);
    if (!data) { el.createDiv({ text: 'lesson.json 缺失，播放器不可用。' }); return; }
    const banner = el.createDiv({ cls: 'elp-player-banner' });
    const play = banner.createEl('button', { cls: 'elp-banner-play', attr: { 'aria-label': '在播放器面板打开' } });
    setIcon(play.createSpan(), 'play');
    const mid = banner.createDiv({ cls: 'elp-banner-mid' });
    mid.createDiv({ cls: 'elp-banner-title', text: data.title });
    mid.createDiv({
      cls: 'elp-banner-meta',
      text: `${data.segments.length} 句 · 生词 ${data.words.length} · 点 ▶ 在右侧播放器打开，正文里任意 ▶ 跳句`,
    });
    const open = async (seg?: number) => {
      const pane = await openPlayerPane(plugin);
      pane?.showLesson(ctx.sourcePath, data, seg);
    };
    play.onclick = () => void open(0);
    banner.onclick = (e) => { if (e.target !== play && !play.contains(e.target as Node)) void open(); };
  });

  // ---- ▶ 跳转：全局事件委托，阅读/实时预览通吃 ----
  plugin.registerDomEvent(document, 'click', (ev) => {
    const span = (ev.target as HTMLElement | null)?.closest?.('.lexora-jump') as HTMLElement | null;
    if (!span) return;
    ev.preventDefault();
    ev.stopPropagation();
    const seg = parseInt(span.getAttribute('data-seg') ?? '', 10);
    const endRaw = parseInt(span.getAttribute('data-seg-end') ?? '', 10);
    if (!Number.isNaN(seg)) void handleJump(plugin, span, seg, Number.isNaN(endRaw) ? undefined : endRaw);
  });

  // ---- clips/*.mp3 嵌入 → 轻量播放胶囊（替代 Obsidian 笨重的原生音频卡片） ----
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    const base = normalizePath(plugin.settings.lessonsFolder) + '/';
    if (!ctx.sourcePath.startsWith(base)) return;
    const embeds = el.querySelectorAll<HTMLElement>(
      'span.internal-embed[src^="clips/"][src$=".mp3"], span.internal-embed[src^="recordings/"][src$=".webm"], span.internal-embed[src^="recordings/"][src$=".m4a"]',
    );
    for (const emb of Array.from(embeds)) {
      const src = emb.getAttribute('src');
      if (src) emb.replaceWith(buildClipPill(plugin, ctx.sourcePath, src));
    }

    // ---- 跟读打卡：把 "跟读：[ ] 1 遍 …" 变成可点的勾选项，点击回写笔记 ----
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('li, p'))
      .filter((n) => (n.textContent ?? '').trim().startsWith('跟读：') && /\[( |x)\]/i.test(n.textContent ?? ''));
    for (const node of nodes) {
      const raw = (node.textContent ?? '').trim();
      const marks = [...raw.matchAll(/\[( |x)\]/gi)];
      const labels = raw.replace(/^跟读：/, '').split(/\[(?: |x)\]/i).map((t) => t.trim());
      const info = ctx.getSectionInfo(el);
      node.empty();
      node.addClass('elp-followline');
      node.createSpan({ cls: 'elp-follow-label', text: '跟读：' });
      marks.forEach((mk, k) => {
        const checked = mk[1].toLowerCase() === 'x';
        const item = node.createSpan({ cls: 'elp-check' + (checked ? ' is-done' : '') });
        item.createSpan({ cls: 'elp-check-box', text: checked ? '✓' : '' });
        const label = labels[k + 1] ?? '';
        if (label) item.createSpan({ cls: 'elp-check-text', text: label });
        item.onclick = () => {
          // 点击时现取区块信息（渲染时的常因虚拟化失效），并带上长难句编号兜底锚点
          const fresh = ctx.getSectionInfo(el);
          let headingNo: number | null = null;
          let blk: Element | null = el;
          while (blk && headingNo === null) {
            const h = blk.querySelector?.('h1,h2,h3,h4,h5,h6');
            if (h) {
              const m = (h.textContent ?? '').trim().match(/^(\d+)\./);
              if (m) headingNo = parseInt(m[1], 10);
              break;
            }
            blk = blk.previousElementSibling;
          }
          void toggleFollowMark(plugin, ctx.sourcePath, k, item, {
            lineStart: fresh?.lineStart ?? info?.lineStart,
            lineEnd: fresh?.lineEnd ?? info?.lineEnd,
            headingNo,
          });
        };
      });
    }
  });
}

/** 切换 学习笔记 里某条跟读行的第 k 个 [ ]/[x]，回写文件。
 *  定位三级兜底：区块行号 → 所属长难句标题号（### N.）→ 全文首条跟读行。 */
async function toggleFollowMark(
  plugin: ElpPlugin, sourcePath: string, k: number, item: HTMLElement,
  loc: { lineStart?: number; lineEnd?: number; headingNo?: number | null },
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return;
  await plugin.app.vault.process(file, (content) => {
    const lines = content.split('\n');
    // 模板行是 `- **跟读**：…`（粗体星号隔开 跟读 和 ：），所以只认 '跟读' + 复选框
    const isFollow = (l: string) => l.includes('跟读') && /\[( |x)\]/i.test(l);
    let target = -1;
    if (loc.lineStart !== undefined && loc.lineEnd !== undefined) {
      for (let ln = Math.max(0, loc.lineStart); ln <= Math.min(loc.lineEnd, lines.length - 1); ln++) {
        if (isFollow(lines[ln])) { target = ln; break; }
      }
    }
    if (target < 0 && loc.headingNo) {
      const h = lines.findIndex((l) => l.startsWith(`### ${loc.headingNo}.`));
      if (h >= 0) {
        for (let ln = h + 1; ln < lines.length && !lines[ln].startsWith('### ') && !lines[ln].startsWith('## '); ln++) {
          if (isFollow(lines[ln])) { target = ln; break; }
        }
      }
    }
    if (target < 0) target = lines.findIndex(isFollow);
    if (target < 0) return content;
    let count = -1;
    lines[target] = lines[target].replace(/\[( |x)\]/gi, (full, c: string) => {
      count++;
      if (count !== k) return full;
      return c.toLowerCase() === 'x' ? '[ ]' : '[x]';
    });
    return lines.join('\n');
  });
  // 立即反馈（文件回写后预览也会自行重渲染该块）
  const done = !item.hasClass('is-done');
  item.toggleClass('is-done', done);
  const box = item.querySelector('.elp-check-box');
  if (box) box.setText(done ? '✓' : '');
}

/** 字幕（当前句卡片）显隐的会话级默认值。 */
let subsHiddenDefault = false;
/** 字幕展示模式：false=单句，true=全文滚动（随当前句滚动+高亮）。 */
let subsScrollDefault = false;

// ---- 轻量切片播放胶囊 ----
let activeClip: HTMLAudioElement | null = null;

function buildClipPill(plugin: ElpPlugin, notePath: string, rel: string): HTMLElement {
  const dir = notePath.split('/').slice(0, -1).join('/');
  const vaultPath = normalizePath(`${dir}/${rel}`);
  const wrap = createSpan({ cls: 'elp-clip' });
  const btn = wrap.createEl('button', { cls: 'elp-clip-btn', attr: { 'aria-label': '播放切片' } });
  const icon = btn.createSpan();
  setIcon(icon, 'play');
  const track = wrap.createSpan({ cls: 'elp-clip-track' });
  const fill = track.createSpan({ cls: 'elp-clip-fill' });
  const time = wrap.createSpan({ cls: 'elp-clip-time', text: '0:00' });

  let audio: HTMLAudioElement | null = null;
  const ensure = (): HTMLAudioElement => {
    if (audio) return audio;
    audio = new Audio(plugin.app.vault.adapter.getResourcePath(vaultPath));
    audio.addEventListener('loadedmetadata', () => {
      if (audio!.duration && Number.isFinite(audio!.duration)) time.setText(fmtTime(audio!.duration));
    });
    audio.addEventListener('timeupdate', () => {
      if (!audio!.duration) return;
      fill.style.width = `${(audio!.currentTime / audio!.duration) * 100}%`;
      time.setText(fmtTime(audio!.currentTime));
    });
    audio.addEventListener('play', () => { wrap.addClass('is-playing'); setIcon(icon, 'pause'); });
    audio.addEventListener('pause', () => { wrap.removeClass('is-playing'); setIcon(icon, 'play'); });
    audio.addEventListener('ended', () => {
      fill.style.width = '0%';
      if (audio!.duration) time.setText(fmtTime(audio!.duration));
    });
    audio.addEventListener('error', () => new Notice(`切片不存在：${rel}`));
    return audio;
  };

  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const a = ensure();
    if (a.paused) {
      if (activeClip && activeClip !== a) activeClip.pause();
      activeClip = a;
      void a.play();
    } else a.pause();
  };
  track.onclick = (e) => {
    e.stopPropagation();
    const a = ensure();
    if (!a.duration) return;
    const r = track.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * a.duration;
    if (a.paused) {
      if (activeClip && activeClip !== a) activeClip.pause();
      activeClip = a;
      void a.play();
    }
  };
  return wrap;
}

interface YoutubeBackend {
  kind: 'youtube';
  iframe: HTMLIFrameElement;
  lastTime: number;
  ready: boolean;
  pending: Array<{ func: string; args: unknown[] }>;
  handshake: number | null;
}

type MediaBackend =
  | { kind: 'local'; el: HTMLMediaElement }
  | YoutubeBackend
  | BilibiliBackend
  | { kind: 'tts' };

/** B 站官方内嵌播放器没有 JS 控制 API：跳转靠带 t 参数重载 iframe，
 *  无法上报播放进度，因此区间自动停止不可用（手动暂停）。 */
interface BilibiliBackend {
  kind: 'bilibili';
  iframe: HTMLIFrameElement;
  bvid: string;
  cid?: number;
  /** 模拟时钟：B 站内嵌播放器无 JS API，用本地时间推进，iframe onload 时校准。 */
  lastTime: number;
  playing: boolean;
  baseAt: number; // Date.now() 起点；0 = iframe 还没加载完
}


function biliEmbedSrc(b: BilibiliBackend, t: number, autoplay: boolean): string {
  const cid = b.cid ? `&cid=${b.cid}` : '';
  return `https://player.bilibili.com/player.html?bvid=${b.bvid}${cid}&page=1&high_quality=1&danmaku=0&autoplay=${autoplay ? 1 : 0}&t=${Math.max(0, Math.floor(t))}`;
}

/** 播放器页面 load 之后到真正出声的初始化+缓冲延迟（经验值，时钟据此滞后起算）。 */
const BILI_STARTUP_LAG_MS = 1100;

function biliNow(b: BilibiliBackend): number {
  if (!b.playing || b.baseAt === 0) return b.lastTime;
  return b.lastTime + Math.max(0, Date.now() - b.baseAt) / 1000;
}

function biliLoad(b: BilibiliBackend, t: number, autoplay: boolean): void {
  // embed 的 t 只收整数秒：时钟必须与 URL 同步取整，否则凭空领先最多 1 秒
  b.lastTime = Math.max(0, Math.floor(t));
  b.playing = autoplay;
  b.baseAt = 0;
  b.iframe.onload = () => { b.baseAt = Date.now() + BILI_STARTUP_LAG_MS; };
  b.iframe.src = biliEmbedSrc(b, b.lastTime, autoplay);
}

export class PlayerController {
  private backend: MediaBackend;
  private current = -1;
  private loop = false;
  private rate = 1;
  private watcher: number | null = null;
  private rootEl: HTMLElement;
  private sentenceEl!: HTMLElement;
  private playBtnIcon!: HTMLElement;
  private onMessage: ((e: MessageEvent) => void) | null = null;
  // ---- 跟读录音 ----
  private mediaRecorder: MediaRecorder | null = null;
  private recStream: MediaStream | null = null;
  private recBtn!: HTMLButtonElement;
  private mineBtn!: HTMLButtonElement;
  private mineAudio: HTMLAudioElement | null = null;

  constructor(
    private plugin: ElpPlugin,
    root: HTMLElement,
    private data: LessonData,
    private mdPath: string,
  ) {
    root.addClass('elp-player');
    this.rootEl = root;
    this.backend = this.buildMedia(root);
    this.buildControls(root);
    void this.buildCheckin(root);
  }

  /** 面板底部：本课跟读打卡 x/y + 迷你进度环 + 去打卡（打开笔记）。 */
  private async buildCheckin(root: HTMLElement): Promise<void> {
    const row = root.createDiv({ cls: 'elp-checkin' });
    const ring = row.createDiv({ cls: 'elp-checkin-ring' });
    const ringIn = ring.createDiv({ cls: 'elp-checkin-ring-in' });
    const mid = row.createDiv({ cls: 'elp-checkin-mid' });
    const line1 = mid.createDiv({ cls: 'elp-checkin-title' });
    mid.createDiv({ cls: 'elp-checkin-sub', text: '勾选正文里的跟读项即计入' });
    const go = row.createEl('button', { cls: 'elp-checkin-go', text: '去打卡 →' });
    go.onclick = () => {
      const f = this.plugin.app.vault.getAbstractFileByPath(this.mdPath);
      if (f instanceof TFile) void this.plugin.app.workspace.getLeaf(false).openFile(f, { state: { mode: 'preview' } });
    };
    const refresh = async (): Promise<void> => {
      if (!row.isConnected && ringIn.textContent) return;
      const f = this.plugin.app.vault.getAbstractFileByPath(this.mdPath);
      if (!(f instanceof TFile)) { row.hide(); return; }
      const text = await this.plugin.app.vault.cachedRead(f);
      let checked = 0; let total = 0;
      for (const line of text.split('\n')) {
        if (!line.includes('跟读')) continue;
        checked += (line.match(/\[x\]/gi) ?? []).length;
        total += (line.match(/\[[ x]\]/gi) ?? []).length;
      }
      if (!total) { row.hide(); return; }
      row.show();
      const pct = Math.round((checked / total) * 100);
      ring.style.setProperty('--elp-ring-pct', String(pct));
      ringIn.setText(`${pct}%`);
      line1.setText(`本课跟读打卡 ${checked} / ${total}`);
    };
    await refresh();
    this.plugin.registerEvent(this.plugin.app.vault.on('modify', (f) => {
      if (f.path === this.mdPath && row.isConnected) void refresh();
    }));
  }

  private get lessonDir(): string {
    return this.mdPath.split('/').slice(0, -1).join('/');
  }

  /** 录音容器协商：桌面 Chrome/Electron 产 webm/opus，iOS WKWebView 只支持 mp4/AAC。 */
  private static recTypes = [
    { mime: 'audio/webm', ext: 'webm' },
    { mime: 'audio/mp4', ext: 'm4a' },
  ];

  private static pickRecType(): { mime?: string; ext: string } {
    const MR: typeof MediaRecorder | undefined = (window as never as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    if (MR?.isTypeSupported) {
      for (const t of PlayerController.recTypes) if (MR.isTypeSupported(t.mime)) return t;
    }
    return { mime: undefined, ext: 'webm' };
  }

  private recPath(idx: number, ext = 'webm'): string {
    return `${this.lessonDir}/recordings/seg-${idx}.${ext}`;
  }

  /** 找这句已存在的录音（跨设备可能是 webm 或 m4a）。 */
  private async recFile(idx: number): Promise<{ path: string; mime: string } | null> {
    for (const t of PlayerController.recTypes) {
      const path = this.recPath(idx, t.ext);
      if (await this.plugin.storage.exists(path)) return { path, mime: t.mime };
    }
    return null;
  }

  // ---------- media backends ----------

  private buildMedia(root: HTMLElement): MediaBackend {
    const media = this.data.media;
    if (media?.kind === 'bilibili' && media.bvid) {
      const wrap = root.createDiv({ cls: 'elp-player-video' });
      const iframe = wrap.createEl('iframe', {
        attr: { frameborder: '0', allow: 'autoplay; encrypted-media', allowfullscreen: 'true', scrolling: 'no' },
      });
      const backend: BilibiliBackend = {
        kind: 'bilibili', iframe, bvid: media.bvid, cid: media.cid, lastTime: 0, playing: false, baseAt: 0,
      };
      iframe.src = biliEmbedSrc(backend, 0, false);
      // 桌面端：尝试升级为原生视频流（毫秒级定位 + 区间自动停）；失败无感保持 iframe 嵌入。
      if (Platform.isDesktopApp) void this.upgradeBili(wrap, backend, media.bvid, media.cid);
      return backend;
    }
    if (media?.kind === 'youtube' && media.videoId) {
      const wrap = root.createDiv({ cls: 'elp-player-video' });
      const origin = encodeURIComponent(window.location.origin || 'app://obsidian.md');
      const iframe = wrap.createEl('iframe', {
        attr: {
          src: `https://www.youtube.com/embed/${media.videoId}?enablejsapi=1&playsinline=1&rel=0&origin=${origin}`,
          frameborder: '0',
          allow: 'autoplay; encrypted-media',
          allowfullscreen: 'true',
        },
      });
      const backend: YoutubeBackend = {
        kind: 'youtube', iframe, lastTime: 0, ready: false, pending: [], handshake: null,
      };
      this.onMessage = (e: MessageEvent) => {
        if (!String(e.origin).includes('youtube')) return;
        if (e.source !== iframe.contentWindow) return;
        try {
          const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
          if (msg.event === 'onReady' || msg.event === 'initialDelivery') {
            if (!backend.ready) {
              backend.ready = true;
              if (backend.handshake) { window.clearInterval(backend.handshake); backend.handshake = null; }
              for (const cmd of backend.pending.splice(0)) this.postYt(cmd.func, cmd.args);
            }
          }
          const t = msg.info?.currentTime;
          if (typeof t === 'number') backend.lastTime = t;
        } catch { /* ignore */ }
      };
      window.addEventListener('message', this.onMessage);
      const listen = () => iframe.contentWindow?.postMessage(
        JSON.stringify({ event: 'listening', id: 'lexora', channel: 'widget' }), '*',
      );
      iframe.addEventListener('load', () => {
        listen();
        // YouTube 偶尔吞掉第一次握手：重试直到 onReady。
        backend.handshake = window.setInterval(() => {
          if (backend.ready) {
            if (backend.handshake) window.clearInterval(backend.handshake);
            backend.handshake = null;
            return;
          }
          listen();
        }, 500);
        window.setTimeout(() => {
          if (backend.handshake) { window.clearInterval(backend.handshake); backend.handshake = null; }
        }, 15000);
      });
      return backend;
    }
    if (media?.kind === 'remote' && media.url) {
      // 音频：元素隐藏，UI 用面板自己的封面 + 走带
      const el = root.createEl('audio', { cls: 'is-hidden', attr: { preload: 'metadata' } });
      el.src = media.url;
      return { kind: 'local', el };
    }
    if (media?.kind === 'local' && media.path) {
      const isAudio = /\.(mp3|m4a|wav|ogg|flac)$/i.test(media.path);
      const f = this.plugin.app.vault.getAbstractFileByPath(media.path);
      const src = f instanceof TFile
        ? this.plugin.app.vault.getResourcePath(f)
        : this.plugin.app.vault.adapter.getResourcePath(media.path);
      if (isAudio) {
        const el = root.createEl('audio', { cls: 'is-hidden', attr: { preload: 'metadata' } });
        el.src = src;
        return { kind: 'local', el };
      }
      const wrap = root.createDiv({ cls: 'elp-player-video' });
      const el = wrap.createEl('video', {
        attr: { preload: 'metadata', playsinline: 'true', 'webkit-playsinline': 'true' },
      });
      el.src = src;
      return { kind: 'local', el };
    }
    return { kind: 'tts' };
  }

  /** B 站原生流升级：playurl 直链经 Node 通道下载到本地缓存后用 <video> 播放——
   *  与本地视频同级的毫秒定位/区间自动停/倍速，且免疫 Chromium 进程内拦截器。
   *  下载期间官方 iframe 照常可用，完成后无感切换并续播当前进度；失败保持 iframe。 */
  private async upgradeBili(wrap: HTMLElement, old: BilibiliBackend, bvid: string, cid?: number): Promise<void> {
    const badge = wrap.createDiv({ cls: 'elp-bili-loading', text: '高精度视频流载入中…' });
    try {
      const rel = await downloadBiliStream(this.plugin, bvid, cid, (pct) => {
        badge.setText(`高精度视频流载入中 ${pct}%`);
      });
      if (this.backend !== old) return; // 面板已重建
      const el = wrap.createEl('video', {
        attr: { preload: 'metadata', playsinline: 'true', 'webkit-playsinline': 'true' },
      });
      el.src = this.plugin.app.vault.adapter.getResourcePath(rel);
      const resume = old.playing ? biliNow(old) : old.lastTime;
      el.addEventListener('loadedmetadata', () => {
        el.currentTime = resume;
        if (old.playing) { el.playbackRate = this.rate; void el.play(); }
      }, { once: true });
      old.iframe.src = 'about:blank';
      old.iframe.style.display = 'none';
      this.backend = { kind: 'local', el };
      wrap.createDiv({ cls: 'elp-stream-badge', text: '高精度流' });
    } catch (e) {
      console.warn('[lexora] B 站原生流不可用，保持官方嵌入播放：', e);
    } finally {
      badge.remove();
    }
  }

  /** 是否有可见画面（YouTube iframe 或本地视频）。 */
  hasVideo(): boolean {
    if (this.backend.kind === 'youtube' || this.backend.kind === 'bilibili') return true;
    return this.backend.kind === 'local' && this.backend.el.tagName === 'VIDEO';
  }

  private postYt(func: string, args: unknown[]): void {
    if (this.backend.kind !== 'youtube') return;
    this.backend.iframe.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args }), '*',
    );
  }

  private yt(func: string, args: unknown[] = []): void {
    if (this.backend.kind !== 'youtube') return;
    if (!this.backend.ready) { this.backend.pending.push({ func, args }); return; }
    this.postYt(func, args);
  }

  private now(): number {
    if (this.backend.kind === 'local') return this.backend.el.currentTime;
    if (this.backend.kind === 'youtube') return this.backend.lastTime;
    if (this.backend.kind === 'bilibili') return biliNow(this.backend);
    return 0;
  }

  private seekPlay(t: number): void {
    if (this.backend.kind === 'local') {
      this.backend.el.currentTime = t;
      this.backend.el.playbackRate = this.rate;
      void this.backend.el.play();
    } else if (this.backend.kind === 'bilibili') {
      biliLoad(this.backend, t, true);
    } else if (this.backend.kind === 'youtube') {
      this.yt('seekTo', [t, true]);
      this.yt('setPlaybackRate', [this.rate]);
      this.yt('playVideo');
      this.backend.lastTime = t;
    }
  }

  private pause(): void {
    if (this.backend.kind === 'local') this.backend.el.pause();
    else if (this.backend.kind === 'youtube') this.yt('pauseVideo');
    else if (this.backend.kind === 'bilibili') biliLoad(this.backend, biliNow(this.backend), false);
    this.setPlayIcon(false);
  }

  // ---------- public API ----------

  /** 区间播放的边界（单句时 rangeEnd === rangeStart）。 */
  private rangeStart = 0;
  private rangeEnd = 0;
  /** TTS 连读序号（递增即打断旧序列）与状态。 */
  private ttsSeq = 0;
  private ttsPlaying = false;
  private transcriptEl: HTMLElement | null = null;
  /** 连播进行中（按钮高亮；任何暂停/手动点句即退出）。 */
  private chaining = false;
  private chainBtn: HTMLElement | null = null;

  private clearChain(): void {
    this.chaining = false;
    this.chainBtn?.removeClass('is-on');
  }

  /** 文本课：从 from 逐句 TTS 连读到 to；loop 时循环整个区间。 */
  private speakRange(from: number, to: number): void {
    const token = ++this.ttsSeq;
    this.ttsPlaying = true;
    this.setPlayIcon(true);
    const step = (i: number): void => {
      if (token !== this.ttsSeq) return;
      if (i > to) {
        if (this.loop) { step(from); return; }
        this.ttsPlaying = false;
        this.setPlayIcon(false);
        return;
      }
      this.current = i;
      this.updateSentence();
      pronounce(this.data.segments[i].text, {
        rate: this.rate * 0.95,
        onEnd: () => step(i + 1),
      });
    };
    step(from);
  }

  private stopTts(): void {
    this.ttsSeq++;
    this.ttsPlaying = false;
    stopPronounce();
  }

  /** 播放一句（endIdx 给定时播放 [idx..endIdx] 整个区间，如段落 ▶）。 */
  playSegment(idx: number, endIdx?: number): void {
    this.clearChain();
    const seg = this.data.segments[idx];
    if (!seg) return;
    const lastIdx = Math.min(Math.max(endIdx ?? idx, idx), this.data.segments.length - 1);
    const last = this.data.segments[lastIdx];
    this.current = idx;
    this.rangeStart = idx;
    this.rangeEnd = lastIdx;
    this.updateSentence();
    if (this.backend.kind === 'tts') {
      this.speakRange(idx, lastIdx);
      return;
    }
    if (seg.start === undefined || seg.end === undefined || last.end === undefined) {
      // 媒体存在但该句无时间轴（如未转写的文章原声课）→ TTS 朗读
      pronounce(seg.text, { rate: this.rate * 0.95 });
      this.setPlayIcon(true);
      return;
    }
    this.seekPlay(Math.max(0, seg.start - 0.05));
    this.setPlayIcon(true);
    this.startWatcher(seg.start, last.end);
  }

  private startWatcher(start: number, end: number): void {
    this.stopWatcher();
    this.watcher = window.setInterval(() => {
      const t = this.now();
      // 区间播放时，随播放进度推进"当前句"显示
      if (this.rangeEnd > this.rangeStart) {
        for (let i = this.rangeStart; i <= this.rangeEnd; i++) {
          const s = this.data.segments[i];
          if (s.start !== undefined && s.end !== undefined && t >= s.start - 0.05 && t < s.end) {
            if (i !== this.current) { this.current = i; this.updateSentence(); }
            break;
          }
        }
      }
      if (t >= end - 0.05) {
        if (this.loop) {
          this.seekPlay(Math.max(0, start - 0.05));
          if (this.current !== this.rangeStart) { this.current = this.rangeStart; this.updateSentence(); }
        } else { this.pause(); this.stopWatcher(); }
      }
    }, 100);
  }

  private stopWatcher(): void {
    if (this.watcher) { window.clearInterval(this.watcher); this.watcher = null; }
  }

  destroy(): void {
    this.stopTts();
    this.stopRecorderTracks();
    this.mineAudio?.pause();
    this.stopWatcher();
    if (this.backend.kind === 'youtube' && this.backend.handshake) {
      window.clearInterval(this.backend.handshake);
    }
    if (this.onMessage) window.removeEventListener('message', this.onMessage);
    this.pause();
  }

  // ---------- UI ----------

  private setPlayIcon(playing: boolean): void {
    if (!playing) this.clearChain();
    if (this.playBtnIcon) setIcon(this.playBtnIcon, playing ? 'pause' : 'play');
  }

  private async refreshMineBtn(): Promise<void> {
    if (!this.mineBtn) return;
    const has = this.current >= 0 && (await this.recFile(this.current)) !== null;
    this.mineBtn.toggleClass('is-hidden', !has);
  }

  private progressSaveTimer: number | null = null;

  /** 记录「学到第几句」，3 秒节流落盘；学习笔记页的「继续上次」据此恢复。 */
  private recordProgress(): void {
    if (this.current < 0) return;
    const lp = (this.plugin.settings.lessonProgress ??= {});
    lp[this.mdPath] = { idx: this.current, total: this.data.segments.length, at: Date.now() };
    const keys = Object.keys(lp);
    if (keys.length > 100) {
      keys.sort((a, b) => lp[a].at - lp[b].at).slice(0, keys.length - 100).forEach((k) => delete lp[k]);
    }
    if (this.progressSaveTimer) window.clearTimeout(this.progressSaveTimer);
    this.progressSaveTimer = window.setTimeout(() => void this.plugin.saveSettings(), 3000);
  }

  private updateSentence(): void {
    this.recordProgress();
    if (this.transcriptEl) {
      this.transcriptEl.querySelectorAll('.elp-ts-sent').forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        const i = Number(n.getAttr('data-idx'));
        n.toggleClass('is-current', i === this.current);
        n.toggleClass('is-past', this.current >= 0 && i < this.current);
      });
      const cur = this.transcriptEl.querySelector(`.elp-ts-sent[data-idx="${this.current}"]`);
      if (cur instanceof HTMLElement) {
        if (this.transcriptEl.hasClass('elp-ts-scrollbox')) {
          // 只滚字幕盒自身，绝不带动面板（否则视频会被顶出视口）
          const top = Math.max(0, cur.offsetTop - this.transcriptEl.clientHeight / 2 + cur.offsetHeight / 2);
          this.transcriptEl.scrollTo({ top, behavior: 'smooth' });
        } else {
          cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    }
    void this.refreshMineBtn();
    const seg = this.data.segments[this.current];
    if (!this.sentenceEl) return;
    this.sentenceEl.empty();
    if (!seg) { this.sentenceEl.setText('点击任意 ▶ 跳到对应句子，默认单句循环'); return; }
    const time = seg.start !== undefined ? `[${fmtTime(seg.start)}] ` : '';
    this.sentenceEl.createSpan({ cls: 'elp-player-time', text: time });
    this.sentenceEl.createSpan({ text: seg.text });
  }

  private buildControls(root: HTMLElement): void {
    // 音频/TTS 课：大封面占位（参考播客阅读器）
    if (!this.hasVideo()) {
      const art = root.createDiv({ cls: 'elp-pane-art' });
      setIcon(art.createSpan(), this.backend.kind === 'tts' ? 'type' : 'headphones');
    }

    root.createDiv({ cls: 'elp-pane-title', text: this.data.title });
    const sub: string[] = [];
    if (this.data.source.feedName) sub.push(this.data.source.feedName);
    sub.push(`${this.data.segments.length} 句`);
    if (this.backend.kind === 'tts') sub.push('文本课 · TTS 朗读');
    root.createDiv({ cls: 'elp-pane-sub', text: sub.join(' · ') });

    // ---- 主走带：上一句 / 播放 / 下一句 / 循环 ----
    const bar = root.createDiv({ cls: 'elp-pane-transport' });
    iconButton(bar, 'skip-back', '上一句', () => {
      this.playSegment(Math.max(0, this.current <= 0 ? 0 : this.current - 1));
    }, 'elp-pane-side');
    const playBtn = bar.createEl('button', { cls: 'elp-pane-play', attr: { 'aria-label': '播放/暂停当前句' } });
    this.playBtnIcon = playBtn.createSpan();
    setIcon(this.playBtnIcon, 'play');
    playBtn.onclick = () => {
      if (this.backend.kind === 'tts' && this.ttsPlaying) { this.stopTts(); this.setPlayIcon(false); return; }
      if (this.current < 0) { this.playSegment(0); return; }
      if (this.backend.kind === 'tts') { this.speakRange(this.current, this.rangeEnd > this.rangeStart ? this.rangeEnd : this.data.segments.length - 1); return; }
      this.playSegment(this.current);
    };
    iconButton(bar, 'skip-forward', '下一句', () => {
      this.playSegment(Math.min(this.data.segments.length - 1, this.current + 1));
    }, 'elp-pane-side');
    const loopBtn = bar.createEl('button', {
      cls: 'elp-icon-btn elp-pane-side elp-player-loop',
      attr: { 'aria-label': '单句循环', title: '单句循环' },
    });
    const loopIcon = loopBtn.createSpan();
    setIcon(loopIcon, 'repeat-1');
    loopBtn.onclick = () => {
      this.loop = !this.loop;
      loopBtn.toggleClass('is-on', this.loop);
    };
    const chainBtn = iconButton(bar, 'list-video', '连播到结尾（从当前句不停顿播完；再点停止）', () => {
      if (this.chaining) { this.pause(); return; }
      const start = this.current < 0 ? 0 : this.current;
      this.playSegment(start, this.data.segments.length - 1);
      this.chaining = true;
      chainBtn.addClass('is-on');
    }, 'elp-pane-side');
    this.chainBtn = chainBtn;

    // ---- 进度条（本地/远程音视频才有真实时间轴） ----
    if (this.backend.kind === 'local') {
      const media = this.backend.el;
      const prog = root.createDiv({ cls: 'elp-pane-progress' });
      const cur = prog.createSpan({ cls: 'elp-pane-time', text: '0:00' });
      const slider = prog.createEl('input', { cls: 'elp-pane-slider', attr: { type: 'range', min: '0', max: '1000', value: '0' } });
      const total = prog.createSpan({ cls: 'elp-pane-time', text: '--:--' });
      media.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(media.duration)) total.setText(fmtTime(media.duration));
      });
      media.addEventListener('timeupdate', () => {
        cur.setText(fmtTime(media.currentTime));
        if (media.duration) slider.value = String(Math.round((media.currentTime / media.duration) * 1000));
      });
      slider.oninput = () => {
        if (!media.duration) return;
        media.currentTime = (parseInt(slider.value, 10) / 1000) * media.duration;
      };
    }

    // ---- 次级行：速度 / 录音 / 我的跟读 ----
    const row2 = root.createDiv({ cls: 'elp-pane-row2' });
    {
      const speed = row2.createEl('select', { cls: 'dropdown elp-player-speed' });
      for (const r of [0.75, 0.9, 1, 1.25]) {
        const opt = speed.createEl('option', { text: `${r}×`, value: String(r) });
        if (r === 1) opt.selected = true;
      }
      speed.onchange = () => {
        this.rate = parseFloat(speed.value);
        if (this.backend.kind === 'local') this.backend.el.playbackRate = this.rate;
        else this.yt('setPlaybackRate', [this.rate]);
      };
    }
    this.recBtn = row2.createEl('button', {
      cls: 'elp-icon-btn elp-rec-btn',
      attr: { 'aria-label': '跟读录音（再次点击结束）', title: '跟读录音' },
    });
    const recIcon = this.recBtn.createSpan();
    setIcon(recIcon, 'mic');
    this.recBtn.onclick = () => void this.toggleRecord();
    this.mineBtn = row2.createEl('button', {
      cls: 'elp-icon-btn elp-mine-btn is-hidden',
      attr: { 'aria-label': '播放我的跟读（与原声对比）', title: '我的跟读' },
    });
    const mineIcon = this.mineBtn.createSpan();
    setIcon(mineIcon, 'user-round');
    this.mineBtn.onclick = () => void this.playMine();

    // 隐藏字幕（盲听训练）
    const capBtn = row2.createEl('button', {
      cls: 'elp-icon-btn' + (subsHiddenDefault ? ' is-dim' : ''),
      attr: { 'aria-label': '显示/隐藏字幕', title: '显示/隐藏字幕' },
    });
    const capIcon = capBtn.createSpan();
    setIcon(capIcon, subsHiddenDefault ? 'captions-off' : 'captions');
    capBtn.onclick = () => {
      subsHiddenDefault = !subsHiddenDefault;
      this.applySubtitleMode();
      setIcon(capIcon, subsHiddenDefault ? 'captions-off' : 'captions');
      capBtn.toggleClass('is-dim', subsHiddenDefault);
    };

    // 字幕模式：单句 ⇄ 全文滚动（文本课本来就是全文，不需要）
    if (this.backend.kind !== 'tts') {
      const modeBtn = row2.createEl('button', {
        cls: 'elp-icon-btn' + (subsScrollDefault ? ' is-on' : ''),
        attr: { 'aria-label': '字幕模式：单句 / 全文滚动', title: '字幕模式：单句 / 全文滚动' },
      });
      const modeIcon = modeBtn.createSpan();
      setIcon(modeIcon, 'scroll-text');
      modeBtn.onclick = () => {
        subsScrollDefault = !subsScrollDefault;
        modeBtn.toggleClass('is-on', subsScrollDefault);
        this.applySubtitleMode();
        this.updateSentence();
      };
    }

    // ---- 当前句 ----
    this.sentenceEl = root.createDiv({ cls: 'elp-pane-sentence' + (subsHiddenDefault || this.backend.kind === 'tts' ? ' is-hidden' : '') });
    this.updateSentence();

    // ---- 全文转写区（当前句高亮+滚动跟随；文本课常驻，音视频课由字幕模式切换） ----
    {
      const wrap = root.createDiv({ cls: 'elp-pane-transcript' + (this.backend.kind !== 'tts' ? ' elp-ts-scrollbox' : '') });
      const ranges = paraRanges(this.data.segments);
      ranges.forEach((p, ri) => {
        const paraEl = wrap.createDiv({ cls: 'elp-ts-para' });
        const endIdx = ranges[ri + 1]?.firstSegIdx ?? this.data.segments.length;
        for (let i = p.firstSegIdx; i < endIdx; i++) {
          const sEl = paraEl.createSpan({ cls: 'elp-ts-sent', text: this.data.segments[i].text + ' ' });
          sEl.setAttr('data-idx', String(i));
          sEl.onclick = () => this.playSegment(i);
        }
      });
      this.transcriptEl = wrap;
    }
    this.applySubtitleMode();
  }

  /** 按 隐藏字幕 + 字幕模式 决定单句区/全文区的可见性。 */
  private applySubtitleMode(): void {
    const tts = this.backend.kind === 'tts';
    const scroll = tts || subsScrollDefault;
    this.sentenceEl?.toggleClass('is-hidden', subsHiddenDefault || scroll);
    this.transcriptEl?.toggleClass('is-hidden', subsHiddenDefault ? !tts : !scroll);
  }

  // ---------- 跟读录音 ----------

  private stopRecorderTracks(): void {
    this.recStream?.getTracks().forEach((t) => t.stop());
    this.recStream = null;
    this.mediaRecorder = null;
    this.recBtn?.removeClass('is-recording');
  }

  private async toggleRecord(): Promise<void> {
    if (this.current < 0) { new Notice('先点一个 ▶ 选中要跟读的句子'); return; }
    if (this.mediaRecorder?.state === 'recording') {
      this.mediaRecorder.stop();
      return;
    }
    try {
      this.pause();
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (first) {
        // Electron 在 macOS 未授权时常报 NotFound 而非 Denied：按设备清单重试一次
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
        const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
        if (mics.length === 0) throw first;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: mics[0].deviceId } },
        });
      }
      this.recStream = stream;
      const chunks: BlobPart[] = [];
      const picked = PlayerController.pickRecType();
      const rec = picked.mime ? new MediaRecorder(stream, { mimeType: picked.mime }) : new MediaRecorder(stream);
      const segIdx = this.current;
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => {
        void (async () => {
          this.stopRecorderTracks();
          const actualMime = rec.mimeType || picked.mime || 'audio/webm';
          const ext = actualMime.includes('mp4') ? 'm4a' : 'webm';
          const blob = new Blob(chunks, { type: actualMime });
          if (blob.size < 200) { new Notice('录音太短'); return; }
          for (const t of PlayerController.recTypes) {
            if (t.ext !== ext) await this.plugin.storage.remove(this.recPath(segIdx, t.ext));
          }
          await this.plugin.storage.writeBinary(this.recPath(segIdx, ext), await blob.arrayBuffer());
          new Notice('录音已保存，自动回放对比');
          await this.refreshMineBtn();
          await this.playMine();
        })();
      };
      rec.start();
      this.mediaRecorder = rec;
      this.recBtn.addClass('is-recording');
      new Notice('录音中… 再次点击 🎙 结束');
    } catch (e) {
      this.stopRecorderTracks();
      new Notice(
        `无法录音：${(e as Error).message}\n` +
        (Platform.isMobileApp
          ? '请在系统设置中允许 Obsidian 使用麦克风后重试。'
          : 'Obsidian 还没拿到 macOS 麦克风授权。修复：设置→核心插件→启用「录音机」并开始一次录音触发系统弹窗 → 允许 → 重启 Obsidian。'),
        12000,
      );
    }
  }

  private async playMine(): Promise<void> {
    if (this.current < 0) return;
    const rec = await this.recFile(this.current);
    const buf = rec ? await this.plugin.storage.readBinary(rec.path) : null;
    if (!rec || !buf) { new Notice('这句还没有录音'); return; }
    this.pause();
    this.mineAudio?.pause();
    const url = URL.createObjectURL(new Blob([buf], { type: rec.mime }));
    this.mineAudio = new Audio(url);
    this.mineAudio.onended = () => URL.revokeObjectURL(url);
    void this.mineAudio.play();
  }
}
