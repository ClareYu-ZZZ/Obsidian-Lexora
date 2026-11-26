import { App, TFile, normalizePath } from 'obsidian';
import type { LessonData } from '@elp/core';
import { openPlayerPane } from './player-pane';
import type ElpPlugin from './main';
import { ConfirmModal, iconButton } from './ui';
import { deleteLesson } from './generate';

interface NoteRow {
  data: LessonData;
  notePath: string;
  checked: number;
  totalBoxes: number;
}

const KIND_LABEL: Record<string, string> = {
  article: '文章',
  youtube: 'YouTube',
  'local-media': '本地媒体',
  note: '笔记',
};

/** 学习笔记仪表盘：扫描教程目录，统计跟读打卡完成情况。 */
export class NotesPanel {
  private root!: HTMLElement;
  private rows: NoteRow[] = [];

  private refreshTimer: number | null = null;
  private sortMode: 'recent' | 'progress' | 'created' = 'recent';

  constructor(private plugin: ElpPlugin, private app: App) {
    // 跟读勾选等改动落盘后 800ms 自动重扫，仪表盘实时反映进度
    this.plugin.registerEvent(this.app.vault.on('modify', (f) => {
      if (!f.path.startsWith(this.plugin.settings.lessonsFolder + '/')) return;
      if (!this.root || !this.root.isConnected) return;
      if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => void this.refresh(), 800);
    }));
  }

  mount(root: HTMLElement): void {
    this.root = root;
    void this.refresh();
  }

  requestRefresh(): void {
    if (this.root) void this.refresh();
  }

  private async refresh(): Promise<void> {
    const base = normalizePath(this.plugin.settings.lessonsFolder);
    const jsons = this.app.vault.getFiles().filter(
      (f) => f.name === 'lesson.json' && f.path.startsWith(base + '/'),
    );
    const rows: NoteRow[] = [];
    for (const jf of jsons) {
      try {
        const data = JSON.parse(await this.app.vault.cachedRead(jf)) as LessonData;
        const dir = jf.parent?.path ?? '';
        const note = this.app.vault.getFiles().find(
          (f) => (f.parent?.path ?? '') === dir && (f.name === '学习笔记.md' || f.name === 'lesson.md'),
        );
        if (!note) continue;
        const text = await this.app.vault.cachedRead(note);
        let checked = 0, totalBoxes = 0;
        for (const line of text.split('\n')) {
          if (!line.includes('跟读')) continue;
          checked += (line.match(/\[x\]/gi) ?? []).length;
          totalBoxes += (line.match(/\[[ x]\]/gi) ?? []).length;
        }
        rows.push({ data, notePath: note.path, checked, totalBoxes });
      } catch { /* skip broken */ }
    }
    rows.sort((a, b) => b.data.createdAt.localeCompare(a.data.createdAt));
    this.rows = rows;
    this.render();
  }

  private render(): void {
    const root = this.root;
    root.empty();
    root.addClass('elp-notes');

    // ---- 汇总 ----
    const weekAgo = Date.now() - 7 * 86400000;
    const thisWeek = this.rows.filter((r) => Date.parse(r.data.createdAt) >= weekAgo).length;
    const totals = this.rows.reduce(
      (acc, r) => ({ c: acc.c + r.checked, t: acc.t + r.totalBoxes }),
      { c: 0, t: 0 },
    );
    const avg = totals.t ? Math.round((totals.c / totals.t) * 100) : 0;
    const words = this.rows.reduce((n, r) => n + r.data.words.length, 0);

    const banner = root.createDiv({ cls: 'elp-stats-banner' });
    const stat = (value: string, label: string, accent = false) => {
      const box = banner.createDiv({ cls: 'elp-stat' + (accent ? ' is-accent' : '') });
      box.createDiv({ cls: 'elp-stat-value', text: value });
      box.createDiv({ cls: 'elp-stat-label', text: label });
    };
    stat(String(this.rows.length), '学习笔记', true);
    stat(String(thisWeek), '本周新增');
    stat(`${avg}%`, '跟读完成率');
    stat(String(words), '累计挖词');
    const actions = banner.createDiv({ cls: 'elp-stats-actions' });
    iconButton(actions, 'refresh-cw', '重新扫描', () => void this.refresh());

    if (this.rows.length === 0) {
      root.createDiv({
        cls: 'elp-sidebar-empty',
        text: `「${this.plugin.settings.lessonsFolder}」下还没有学习笔记。去订阅中心生成一篇吧。`,
      });
      return;
    }

    // ---- 列表 ----
    // ---- 继续上次学习 ----
    const lp = this.plugin.settings.lessonProgress ?? {};
    const lastPath = Object.keys(lp)
      .filter((k) => this.rows.some((r) => r.notePath === k))
      .sort((a, b) => lp[b].at - lp[a].at)[0];
    if (lastPath) {
      const row = this.rows.find((r) => r.notePath === lastPath);
      const rec = lp[lastPath];
      if (row && rec && rec.idx + 1 < rec.total) {
        const hero = root.createDiv({ cls: 'elp-continue' });
        const pct = Math.round(((rec.idx + 1) / rec.total) * 100);
        const ring = hero.createDiv({ cls: 'elp-continue-ring' });
        ring.style.setProperty('--elp-ring-pct', String(pct));
        ring.createDiv({ cls: 'elp-continue-ring-in', text: `${pct}%` });
        const mid = hero.createDiv({ cls: 'elp-continue-mid' });
        mid.createDiv({ cls: 'elp-continue-label', text: '继续上次学习' });
        mid.createDiv({ cls: 'elp-continue-title', text: row.data.title });
        mid.createDiv({ cls: 'elp-continue-meta', text: `学到第 ${rec.idx + 1} 句 / 共 ${rec.total} 句 · ${relTime(rec.at)}` });
        const go = hero.createEl('button', { cls: 'elp-continue-btn', text: '▶ 继续' });
        go.onclick = () => void this.continueLesson(row, rec.idx);
      }
    }

    // ---- 排序 ----
    const sortBar = root.createDiv({ cls: 'elp-notes-sort' });
    const sorts: Array<{ id: 'recent' | 'progress' | 'created'; label: string }> = [
      { id: 'recent', label: '最近学习' },
      { id: 'progress', label: '完成度低' },
      { id: 'created', label: '创建时间' },
    ];
    sortBar.createSpan({ cls: 'elp-notes-sort-label', text: '排序' });
    for (const so of sorts) {
      const b = sortBar.createEl('button', {
        cls: 'elp-sort-chip' + (this.sortMode === so.id ? ' is-active' : ''), text: so.label,
      });
      b.onclick = () => { this.sortMode = so.id; this.render(); };
    }
    const sorted = [...this.rows].sort((a, b) => {
      if (this.sortMode === 'recent') return (lp[b.notePath]?.at ?? 0) - (lp[a.notePath]?.at ?? 0);
      if (this.sortMode === 'progress') {
        const pa = a.totalBoxes ? a.checked / a.totalBoxes : 0;
        const pb = b.totalBoxes ? b.checked / b.totalBoxes : 0;
        return pa - pb;
      }
      return (b.data.createdAt ?? '').localeCompare(a.data.createdAt ?? '');
    });

    const list = root.createDiv({ cls: 'elp-notes-list' });
    for (const row of sorted) {
      const item = list.createDiv({ cls: 'elp-note-item' });
      item.onclick = () => {
        const f = this.app.vault.getAbstractFileByPath(row.notePath);
        if (f instanceof TFile) void this.app.workspace.getLeaf(true).openFile(f, { state: { mode: 'preview' } });
      };

      const main = item.createDiv({ cls: 'elp-note-main' });
      main.createDiv({ cls: 'elp-note-title', text: row.data.title });
      const meta = main.createDiv({ cls: 'elp-note-meta' });
      meta.createSpan({ cls: 'elp-tag', text: KIND_LABEL[row.data.source.kind] ?? row.data.source.kind });
      if (row.data.media?.kind === 'local' || row.data.clips) meta.createSpan({ cls: 'elp-tag', text: '原声' });
      meta.createSpan({ text: row.data.createdAt.slice(0, 10) });
      meta.createSpan({ text: `生词 ${row.data.words.length}` });
      meta.createSpan({ text: `长难句 ${row.data.hard.length}` });
      const rp = (this.plugin.settings.lessonProgress ?? {})[row.notePath];
      if (rp && rp.idx + 1 < rp.total) meta.createSpan({ cls: 'elp-note-resume', text: `上次学到第 ${rp.idx + 1} 句` });

      const prog = item.createDiv({ cls: 'elp-note-progress' });
      const pct = row.totalBoxes ? Math.round((row.checked / row.totalBoxes) * 100) : 0;
      const barWrap = prog.createDiv({ cls: 'elp-vocab-bar' });
      const bar = barWrap.createDiv({ cls: 'elp-vocab-bar-fill' + (pct >= 100 ? ' is-done' : '') });
      bar.style.width = `${pct}%`;
      prog.createSpan({ cls: 'elp-note-pct', text: `跟读 ${pct}%` });
      {
        const rp2 = (this.plugin.settings.lessonProgress ?? {})[row.notePath];
        if (rp2 && rp2.idx + 1 < rp2.total) {
          const cont = prog.createEl('button', { cls: 'elp-note-continue', text: '继续' });
          cont.onclick = (e) => { e.stopPropagation(); void this.continueLesson(row, rp2.idx); };
        }
      }
      iconButton(prog, 'trash-2', '删除这篇教程（含切片与录音）', () =>
        new ConfirmModal(
          this.app, '删除教程',
          `删除「${row.data.title}」的学习笔记、切片和录音？文件会移入系统回收站，可找回。`,
          '删除',
          () => void deleteLesson(this.plugin, row.notePath).then(() => this.refresh()),
        ).open(), 'elp-row-del');
    }
  }
  /** 打开笔记并让右侧播放器跳到上次句子。 */
  private async continueLesson(row: NoteRow, idx: number): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(row.notePath);
    if (f instanceof TFile) await this.app.workspace.getLeaf(true).openFile(f, { state: { mode: 'preview' } });
    const pane = await openPlayerPane(this.plugin);
    pane?.showLesson(row.notePath, row.data, idx);
  }

}

/** 粗粒度相对时间：刚刚/N 分钟前/N 小时前/N 天前。 */
function relTime(at: number): string {
  const d = Date.now() - at;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}
