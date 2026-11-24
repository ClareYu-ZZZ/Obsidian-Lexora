/**
 * 学习笔记右下角悬浮环形进度：当前笔记的跟读打卡完成度（勾选即时刷新）。
 * 纯 CSS conic-gradient 画环，点击滚动到第一处未完成的跟读项。
 */
import { MarkdownView, TFile, debounce } from 'obsidian';
import type ElpPlugin from './main';

const HOST_CLS = 'elp-ring-host';

async function render(plugin: ElpPlugin): Promise<void> {
  document.querySelectorAll(`.${HOST_CLS}`).forEach((e) => e.remove());
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  // 内容驱动：任何含跟读打卡项的笔记都显示进度环（不依赖目录/文件名）
  if (!view?.file || !(view.file instanceof TFile)) return;
  const text = await plugin.app.vault.cachedRead(view.file);
  let checked = 0;
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('跟读')) continue;
    checked += (line.match(/\[x\]/gi) ?? []).length;
    total += (line.match(/\[[ x]\]/gi) ?? []).length;
  }
  if (total === 0) return;
  const pct = Math.round((checked / total) * 100);

  view.containerEl.addClass('elp-ring-anchor');
  const host = view.containerEl.createDiv({ cls: HOST_CLS });
  host.setAttribute('aria-label', `跟读打卡 ${checked}/${total}，点击跳到下一个未完成项`);
  const ring = host.createDiv({ cls: 'elp-ring' + (pct >= 100 ? ' is-full' : '') });
  ring.style.setProperty('--elp-ring-pct', String(pct));
  const inner = ring.createDiv({ cls: 'elp-ring-in' });
  inner.createDiv({ cls: 'elp-ring-pct', text: pct >= 100 ? '✓' : `${pct}%` });
  inner.createDiv({ cls: 'elp-ring-sub', text: '跟读' });
  host.onclick = () => {
    const next = view.containerEl.querySelector('.elp-check:not(.is-done)');
    (next ?? view.containerEl.querySelector('.elp-followline'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
}

export function setupProgressRing(plugin: ElpPlugin): void {
  const refresh = debounce(() => void render(plugin), 150, true);
  plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', refresh));
  plugin.registerEvent(plugin.app.workspace.on('file-open', refresh));
  plugin.registerEvent(plugin.app.vault.on('modify', (f) => {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file && f.path === view.file.path) refresh();
  }));
  plugin.app.workspace.onLayoutReady(() => refresh());
}
