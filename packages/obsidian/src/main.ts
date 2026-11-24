import { LicenseManager } from './license';
import { setupProgressRing } from './progress-ring';
import { probeOverseas } from './yt-net';
import { checkForUpdate, sendTelemetryPing } from './telemetry';
import { MarkdownView, Notice, Plugin, WorkspaceLeaf, addIcon } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import {
  BookStore, EcdictDictionary, HighlightIndex, ReviewLog, buildDictIndex,
} from '@elp/core';
import {
  DEFAULT_SETTINGS, ElpSettingTab, booksFolder, dictCacheFolder, type ElpSettings,
} from './settings';
import { VaultStorage } from './vaultStorage';
import { buildEditorExtension, elpRefreshEffect, highlightElement } from './highlight';
import { HoverManager } from './hover';
import { CollectModal, registerEditorMenu, wordAt } from './collect';
import { SIDEBAR_VIEW_TYPE, WordListView } from './sidebar';
import { HOME_VIEW_TYPE, LexoraView, type HomeTab } from './home-view';
import { FeedsStore } from './feeds-store';
import { WorkerClient } from './worker-client';
import { EudicClient } from './eudic';
import { initAudio } from './audio';
import { registerPlayer } from './player';
import { PLAYER_VIEW_TYPE, PlayerPaneView } from './player-pane';
import { generateFromNote } from './generate';
import { pickLocalMedia } from './local-media';
import { importCanvas, importKnownWords } from './importers';

export default class ElpPlugin extends Plugin {
  settings: ElpSettings = { ...DEFAULT_SETTINGS };
  license!: LicenseManager;
  storage!: VaultStorage;
  store!: BookStore;
  dict!: EcdictDictionary;
  log!: ReviewLog;
  feeds!: FeedsStore;
  worker!: WorkerClient;
  eudic!: EudicClient;
  index = new HighlightIndex();
  private hover!: HoverManager;

  async onload(): Promise<void> {
    // 原创品牌图标：对话气泡 + 声波（线条风，随主题变色）
    addIcon('lexora-mark', `<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M87 62a9 9 0 0 1-9 9H33l-16 16V21a9 9 0 0 1 9-9h52a9 9 0 0 1 9 9z"/>
      <path d="M35 48v-8"/>
      <path d="M48 54V30"/>
      <path d="M61 50V34"/>
      <path d="M72 46v-4"/>
    </g>`);

    await this.loadSettings();
    this.license = new LicenseManager(this);
    void this.license.refresh();
    setupProgressRing(this);
    void probeOverseas(this); // 静默探测境外直连，订阅中心据此展示/隐藏境外源
    // 延迟到启动稳定后再做更新检查与匿名统计（都可在设置关闭，且各自节流）
    window.setTimeout(() => {
      void checkForUpdate(this);
      void sendTelemetryPing(this);
    }, 5000);
    this.storage = new VaultStorage(this.app.vault);
    this.store = new BookStore(this.storage, booksFolder(this.settings));
    this.dict = new EcdictDictionary(this.storage, dictCacheFolder(this.settings));
    this.log = new ReviewLog(this.storage, `${booksFolder(this.settings)}/review-log.json`);
    this.feeds = new FeedsStore(this);
    this.worker = new WorkerClient(this);
    this.eudic = new EudicClient(this);
    initAudio(this);

    this.app.workspace.onLayoutReady(() => void this.initData());

    this.registerEditorExtension(buildEditorExtension(this));
    this.registerMarkdownPostProcessor((el, ctx) => highlightElement(this, el, ctx.sourcePath));
    registerPlayer(this);

    this.hover = new HoverManager(this);
    this.hover.attach();

    registerEditorMenu(this);

    this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new WordListView(leaf, this));
    this.registerView(HOME_VIEW_TYPE, (leaf) => new LexoraView(leaf, this));
    this.registerView(PLAYER_VIEW_TYPE, (leaf) => new PlayerPaneView(leaf, this));

    this.addRibbonIcon('lexora-mark', 'Lexora', () => void this.openHome('books'));
    this.addRibbonIcon('book-a', 'Lexora：生词列表', () => void this.activateSidebar());

    this.addCommand({ id: 'open-home', name: '打开 Lexora', callback: () => void this.openHome() });
    this.addCommand({ id: 'open-feeds', name: '打开订阅中心', callback: () => void this.openHome('feeds') });
    this.addCommand({ id: 'open-books', name: '打开单词本', callback: () => void this.openHome('books') });
    this.addCommand({
      id: 'start-review',
      name: '开始背单词（默认词本）',
      callback: () => {
        const id = this.settings.defaultBookId || this.store.listBooks()[0]?.id;
        if (id) void this.openHome('review', id);
        else new Notice('还没有词本');
      },
    });
    this.addCommand({
      id: 'open-word-list',
      name: '打开生词侧栏',
      callback: () => void this.activateSidebar(),
    });
    this.addCommand({
      id: 'collect-word',
      name: '收录光标处单词',
      editorCallback: (editor, view) => {
        const found = wordAt(editor);
        if (!found) { new Notice('光标处没有英文单词'); return; }
        new CollectModal(this.app, this, found.surface, {
          sentence: found.sentence,
          sourcePath: view.file?.path ?? undefined,
          sourceTitle: view.file?.basename,
        }).open();
      },
    });
    this.addCommand({
      id: 'lesson-from-note',
      name: '从当前笔记生成教程',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === 'md') void generateFromNote(this, file);
        else new Notice('先打开一篇 Markdown 笔记');
      },
    });
    this.addCommand({
      id: 'lesson-from-local-media',
      name: '从本地媒体生成教程（无字幕可转写）',
      callback: () => pickLocalMedia(this),
    });
    this.addCommand({
      id: 'push-book-to-eudic',
      name: '把默认词本推送到欧路生词本',
      callback: () => {
        const id = this.settings.defaultBookId || this.store.listBooks()[0]?.id;
        if (id) void this.eudic.pushBook(id);
      },
    });
    this.addCommand({
      id: 'rebuild-dict-index',
      name: '重建词典索引',
      callback: () => void this.rebuildDictIndex(),
    });
    this.addCommand({
      id: 'import-known-words',
      name: '导入已掌握词表（known-words.txt）',
      callback: () => void importKnownWords(this),
    });
    this.addCommand({
      id: 'import-canvas',
      name: '从 Canvas 词本导入',
      callback: () => importCanvas(this),
    });

    this.addSettingTab(new ElpSettingTab(this.app, this));
    this.applyBodyClasses();
  }

  onunload(): void {
    this.hover?.detach();
    document.body.removeClass('elp-style-background');
  }

  private async initData(): Promise<void> {
    await this.store.load();
    await this.log.load();
    await this.feeds.load();
    if (!this.settings.defaultBookId || !this.store.getBook(this.settings.defaultBookId)) {
      this.settings.defaultBookId = this.store.listBooks()[0]?.id ?? '';
      await this.saveSettings();
    }
    this.refreshAll();
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  applyBodyClasses(): void {
    document.body.toggleClass('elp-style-background', this.settings.highlightStyle === 'background');
  }

  /** Rebuild the highlight index and repaint every view. */
  refreshAll(): void {
    this.index.rebuild(this.store.listBooks(), {
      includeMastered: this.settings.includeMastered,
    });
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      cm?.dispatch({ effects: elpRefreshEffect.of(Date.now()) });
      view.previewMode?.rerender(true);
    }
    for (const leaf of this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)) {
      if (leaf.view instanceof WordListView) leaf.view.requestRefresh();
    }
    this.refreshBooksViews();
  }

  /** 单词级轻量刷新：原地改高亮 DOM，不整页重渲染（避免闪屏与滚动跳位）。 */
  refreshWord(lemma: string): void {
    this.index.rebuild(this.store.listBooks(), {
      includeMastered: this.settings.includeMastered,
    });
    const info = this.index.match(lemma);
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      cm?.dispatch({ effects: elpRefreshEffect.of(Date.now()) });
      const rootEl = view.previewMode?.containerEl;
      if (!rootEl) continue;
      const esc = window.CSS?.escape ? window.CSS.escape(lemma) : lemma.replace(/"/g, '\\"');
      const spans = Array.from(
        rootEl.querySelectorAll<HTMLElement>(`span.elp-word[data-elp-lemma="${esc}"]`),
      );
      for (const sp of spans) {
        if (!info) sp.replaceWith(document.createTextNode(sp.textContent ?? ''));
        else sp.className = `elp-word elp-${info.status}`;
      }
      // 该词在此页还没高亮（如刚收录）：原地补一遍（幂等，已包的会跳过）
      if (info && spans.length === 0 && view.file) {
        highlightElement(this, rootEl, view.file.path);
      }
    }
    for (const leaf of this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)) {
      if (leaf.view instanceof WordListView) leaf.view.requestRefresh();
    }
    this.refreshBooksViews();
  }

  refreshBooksViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)) {
      if (leaf.view instanceof LexoraView) leaf.view.requestRefresh();
    }
  }

  /** 打开 Lexora 主页（可指定内部 tab 与词本）。 */
  async openHome(tab?: HomeTab, bookId?: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)[0];
    const leaf: WorkspaceLeaf = existing ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: HOME_VIEW_TYPE,
      active: true,
      state: { tab, bookId },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  /** 兼容旧入口。 */
  async openBooks(): Promise<void> { await this.openHome('books'); }
  async openFeeds(): Promise<void> { await this.openHome('feeds'); }
  async openReview(bookId: string): Promise<void> { await this.openHome('review', bookId); }

  async rebuildDictIndex(): Promise<void> {
    const path = this.settings.dictCsvPath;
    if (!path) { new Notice('先在设置中填写词典 csv 路径'); return; }
    const csv = await this.storage.readText(path);
    if (csv == null) { new Notice(`读不到词典文件：${path}`); return; }
    const notice = new Notice('正在构建词典索引…', 0);
    try {
      const res = await buildDictIndex(csv, this.storage, dictCacheFolder(this.settings), (done, phase) => {
        notice.setMessage(phase === 'parse' ? `解析词条 ${done.toLocaleString()}…` : `写入分片 ${done}…`);
      });
      this.dict.invalidate();
      notice.setMessage(`词典就绪：${res.entries.toLocaleString()} 条 / ${res.shards} 个分片`);
      window.setTimeout(() => notice.hide(), 4000);
    } catch (e) {
      notice.hide();
      new Notice(`索引构建失败：${(e as Error).message}`);
    }
  }

  async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }
}
