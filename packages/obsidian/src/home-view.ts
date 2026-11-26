import { setIcon, ItemView, Scope, WorkspaceLeaf } from 'obsidian';
import type ElpPlugin from './main';
import { FeedsPanel } from './feeds-view';
import { BooksPanel } from './books-view';
import { ReviewPanel } from './review-view';
import { NotesPanel } from './notes-view';

export const HOME_VIEW_TYPE = 'lexora-home';

export type HomeTab = 'feeds' | 'notes' | 'books' | 'review';

interface HomeState {
  tab?: HomeTab;
  bookId?: string;
  [key: string]: unknown;
}

const TABS: Array<{ id: HomeTab; label: string; icon: string }> = [
  { id: 'feeds', label: '订阅中心', icon: 'rss' },
  { id: 'notes', label: '学习笔记', icon: 'notebook-text' },
  { id: 'books', label: '单词本', icon: 'graduation-cap' },
  { id: 'review', label: '背单词', icon: 'layers' },
];

/** Lexora 主页：订阅中心 / 单词本 / 背单词 三合一。 */
export class LexoraView extends ItemView {
  private tab: HomeTab = 'books';
  private navEl!: HTMLElement;
  private hosts!: Record<HomeTab, HTMLElement>;
  private feedsPanel!: FeedsPanel;
  private notesPanel!: NotesPanel;
  private booksPanel!: BooksPanel;
  private reviewPanel!: ReviewPanel;
  private mounted = new Set<HomeTab>();

  constructor(leaf: WorkspaceLeaf, private plugin: ElpPlugin) {
    super(leaf);
    this.scope = new Scope(this.app.scope);
    for (const key of [' ', 'h', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      this.scope.register([], key, (e) => {
        if (this.tab === 'review' && this.reviewPanel.handleKey(e)) {
          e.preventDefault();
          return false;
        }
        return true;
      });
    }
  }

  getViewType(): string { return HOME_VIEW_TYPE; }
  getDisplayText(): string { return 'Lexora'; }
  getIcon(): string { return 'lexora-mark'; }

  getState(): HomeState {
    return { tab: this.tab };
  }

  async setState(state: HomeState, result: unknown): Promise<void> {
    void result;
    const tab = (state?.tab as HomeTab) ?? this.tab;
    const bookId = state?.bookId as string | undefined;
    if (!this.hosts) this.buildSkeleton();
    if (bookId && tab === 'review') this.reviewPanel.setBook(bookId);
    this.switchTab(tab);
  }

  async onOpen(): Promise<void> {
    if (!this.hosts) this.buildSkeleton();
    this.switchTab(this.tab);
  }

  private buildSkeleton(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('elp-home');

    this.feedsPanel = new FeedsPanel(this.plugin, this.app);
    this.notesPanel = new NotesPanel(this.plugin, this.app);
    this.booksPanel = new BooksPanel(this.plugin, this.app, (bookId) => {
      this.reviewPanel.setBook(bookId);
      this.switchTab('review');
    });
    this.reviewPanel = new ReviewPanel(this.plugin, this.app, () => this.switchTab('books'));

    this.navEl = root.createDiv({ cls: 'elp-home-nav' });
    const body = root.createDiv({ cls: 'elp-home-body' });
    this.hosts = {
      feeds: body.createDiv({ cls: 'elp-home-panel' }),
      notes: body.createDiv({ cls: 'elp-home-panel' }),
      books: body.createDiv({ cls: 'elp-home-panel' }),
      review: body.createDiv({ cls: 'elp-home-panel' }),
    };
  }

  switchTab(tab: HomeTab): void {
    this.tab = tab;
    // nav
    this.navEl.empty();
    for (const t of TABS) {
      const btn = this.navEl.createEl('button', {
        cls: 'elp-home-tab' + (t.id === tab ? ' is-active' : ''),
      });
      setIcon(btn.createSpan({ cls: 'elp-home-tab-icon' }), t.icon);
      btn.createSpan({ text: t.label });
      btn.onclick = () => this.switchTab(t.id);
    }
    // panels（懒挂载，切换时保留状态——背单词会话不中断）
    for (const t of TABS) {
      this.hosts[t.id].toggleClass('is-hidden', t.id !== tab);
    }
    if (!this.mounted.has(tab)) {
      this.mounted.add(tab);
      if (tab === 'feeds') this.feedsPanel.mount(this.hosts.feeds);
      else if (tab === 'notes') this.notesPanel.mount(this.hosts.notes);
      else if (tab === 'books') this.booksPanel.mount(this.hosts.books);
      else this.reviewPanel.mount(this.hosts.review);
    } else if (tab === 'books') {
      this.booksPanel.requestRefresh();
    } else if (tab === 'notes') {
      this.notesPanel.requestRefresh();
    }
    this.app.workspace.requestSaveLayout();
  }

  requestRefresh(): void {
    if (!this.hosts) return;
    this.booksPanel?.requestRefresh();
    this.feedsPanel?.requestRefresh();
  }
}
