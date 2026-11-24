/**
 * 独立播放器面板（右侧分屏，参考播客阅读器）：
 * - 学习笔记的 ▶ 跳句 / 播放器横幅 → showLesson()
 * - 订阅中心详情页的音视频 → showMedia()
 */

import { ItemView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type { LessonData } from '@elp/core';
import { fmtTime } from '@elp/core';
import type ElpPlugin from './main';
import { iconButton } from './ui';
import { PlayerController } from './player';

export const PLAYER_VIEW_TYPE = 'lexora-player';

/** 订阅中心媒体：无句级时间轴的整段播放。 */
export interface PaneMedia {
  title: string;
  subtitle?: string;
  cover?: string;
  videoId?: string;
  bvid?: string;
  audioUrl?: string;
}

export class PlayerPaneView extends ItemView {
  private controller: PlayerController | null = null;
  private feedAudio: HTMLAudioElement | null = null;
  private notePath: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: ElpPlugin) {
    super(leaf);
  }

  getViewType(): string { return PLAYER_VIEW_TYPE; }
  getDisplayText(): string { return '播放器'; }
  getIcon(): string { return 'circle-play'; }

  private reset(): HTMLElement {
    this.controller?.destroy();
    this.controller = null;
    this.feedAudio?.pause();
    this.feedAudio = null;
    this.notePath = null;
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('elp-pane');
    return root.createDiv({ cls: 'elp-pane-inner' });
  }

  /** 教程课：句级播放（跳句/循环/跟读）；segEnd 给定时播放整段区间。 */
  showLesson(notePath: string, data: LessonData, segIdx?: number, segEnd?: number): void {
    if (this.notePath === notePath && this.controller) {
      if (segIdx !== undefined) this.controller.playSegment(segIdx, segEnd);
      return;
    }
    const inner = this.reset();
    this.notePath = notePath;

    const head = inner.createDiv({ cls: 'elp-pane-head' });
    iconButton(head, 'file-text', '打开学习笔记', () => {
      const f = this.plugin.app.vault.getAbstractFileByPath(notePath);
      if (f instanceof TFile) void this.plugin.app.workspace.getLeaf(false).openFile(f, { state: { mode: 'preview' } });
    });

    this.controller = new PlayerController(this.plugin, inner, data, notePath);
    if (segIdx !== undefined) this.controller.playSegment(segIdx, segEnd);
  }

  /** 订阅媒体：整段播放（YouTube 视频 / 播客音频）。 */
  showMedia(media: PaneMedia): void {
    const inner = this.reset();

    if (media.bvid) {
      const wrap = inner.createDiv({ cls: 'elp-player-video' });
      wrap.createEl('iframe', {
        attr: {
          src: `https://player.bilibili.com/player.html?bvid=${media.bvid}&page=1&high_quality=1&danmaku=0&autoplay=1`,
          frameborder: '0',
          allow: 'autoplay; encrypted-media; picture-in-picture',
          allowfullscreen: 'true',
          scrolling: 'no',
        },
      });
      inner.createDiv({ cls: 'elp-pane-title', text: media.title });
      if (media.subtitle) inner.createDiv({ cls: 'elp-pane-sub', text: media.subtitle });
      return;
    }
    if (media.videoId) {
      const wrap = inner.createDiv({ cls: 'elp-player-video' });
      wrap.createEl('iframe', {
        attr: {
          src: `https://www.youtube.com/embed/${media.videoId}?rel=0&autoplay=1&playsinline=1`,
          frameborder: '0',
          allow: 'autoplay; encrypted-media; picture-in-picture',
          allowfullscreen: 'true',
        },
      });
      inner.createDiv({ cls: 'elp-pane-title', text: media.title });
      if (media.subtitle) inner.createDiv({ cls: 'elp-pane-sub', text: media.subtitle });
      return;
    }

    // ---- 播客式音频播放器 ----
    const art = inner.createDiv({ cls: 'elp-pane-art' });
    if (media.cover) {
      art.addClass('has-cover');
      art.style.backgroundImage = `url("${media.cover.replace(/"/g, '%22')}")`;
    } else {
      setIcon(art.createSpan(), 'headphones');
    }
    inner.createDiv({ cls: 'elp-pane-title', text: media.title });
    if (media.subtitle) inner.createDiv({ cls: 'elp-pane-sub', text: media.subtitle });

    const audio = new Audio(media.audioUrl ?? '');
    audio.preload = 'metadata';
    this.feedAudio = audio;

    const bar = inner.createDiv({ cls: 'elp-pane-transport' });
    iconButton(bar, 'undo-2', '后退 15 秒', () => {
      audio.currentTime = Math.max(0, audio.currentTime - 15);
    }, 'elp-pane-side');
    const playBtn = bar.createEl('button', { cls: 'elp-pane-play', attr: { 'aria-label': '播放/暂停' } });
    const pi = playBtn.createSpan();
    setIcon(pi, 'play');
    playBtn.onclick = () => { if (audio.paused) void audio.play(); else audio.pause(); };
    audio.addEventListener('play', () => setIcon(pi, 'pause'));
    audio.addEventListener('pause', () => setIcon(pi, 'play'));
    iconButton(bar, 'redo-2', '前进 15 秒', () => {
      audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 15);
    }, 'elp-pane-side');
    const loopBtn = bar.createEl('button', {
      cls: 'elp-icon-btn elp-pane-side elp-player-loop',
      attr: { 'aria-label': '循环播放', title: '循环播放' },
    });
    setIcon(loopBtn.createSpan(), 'repeat');
    loopBtn.onclick = () => { audio.loop = !audio.loop; loopBtn.toggleClass('is-on', audio.loop); };

    const prog = inner.createDiv({ cls: 'elp-pane-progress' });
    const cur = prog.createSpan({ cls: 'elp-pane-time', text: '0:00' });
    const slider = prog.createEl('input', { cls: 'elp-pane-slider', attr: { type: 'range', min: '0', max: '1000', value: '0' } });
    const total = prog.createSpan({ cls: 'elp-pane-time', text: '--:--' });
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration)) total.setText(fmtTime(audio.duration));
    });
    audio.addEventListener('timeupdate', () => {
      cur.setText(fmtTime(audio.currentTime));
      if (audio.duration) slider.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    });
    slider.oninput = () => {
      if (!audio.duration) return;
      audio.currentTime = (parseInt(slider.value, 10) / 1000) * audio.duration;
    };

    const row2 = inner.createDiv({ cls: 'elp-pane-row2' });
    const speed = row2.createEl('select', { cls: 'dropdown elp-player-speed' });
    for (const r of [0.75, 0.9, 1, 1.25, 1.5]) {
      const opt = speed.createEl('option', { text: `${r}×`, value: String(r) });
      if (r === 1) opt.selected = true;
    }
    speed.onchange = () => { audio.playbackRate = parseFloat(speed.value); };

    void audio.play().catch(() => { /* 自动播放被拦截就等用户点 */ });
  }

  async onClose(): Promise<void> {
    this.controller?.destroy();
    this.controller = null;
    this.feedAudio?.pause();
    this.feedAudio = null;
  }
}

/** 打开（或复用）右侧播放器面板。 */
export async function openPlayerPane(plugin: ElpPlugin): Promise<PlayerPaneView | null> {
  const ws = plugin.app.workspace;
  let leaf = ws.getLeavesOfType(PLAYER_VIEW_TYPE)[0];
  if (!leaf) {
    leaf = ws.getLeaf('split', 'vertical');
    await leaf.setViewState({ type: PLAYER_VIEW_TYPE, active: false });
  }
  // Obsidian 1.7 DeferredView：确保视图实例已加载
  const maybe = leaf as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> };
  if (!(leaf.view instanceof PlayerPaneView) && maybe.loadIfDeferred) await maybe.loadIfDeferred();
  ws.revealLeaf(leaf);
  return leaf.view instanceof PlayerPaneView ? leaf.view : null;
}
