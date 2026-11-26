import type { App } from 'obsidian';
import { setIcon, Notice } from 'obsidian';
import {
  buildChoices, buildSession, isProReviewMode, pickExample,
  type ReviewRating, type SessionItem, type WordCard } from '@elp/core';
import type ElpPlugin from './main';
import { lookupOnline } from './online-dict';
import { pronounce } from './audio';
import { iconButton, renderSentence } from './ui';

/** 背单词面板：五种模式 + ←↓→↑ 快捷键 + 自动发音 + 例句展示。 */
export class ReviewPanel {
  private root!: HTMLElement;
  private bookId: string | null = null;
  private queue: SessionItem[] = [];
  private idx = 0;
  private revealed = false;
  private answeredCorrect: boolean | null = null;
  private doneNew = 0;
  private doneReview = 0;
  private finished = true;
  private streak = 0;

  constructor(
    private plugin: ElpPlugin,
    private app: App,
    private onBack: () => void,
  ) {}

  mount(root: HTMLElement): void {
    this.root = root;
    this.render();
  }

  /** 主页快捷键委托（本面板激活时）。返回是否消费了按键。 */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.root || this.finished && !this.current) return false;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
    switch (e.key) {
      case ' ': this.onSpace(); return true;
      case 'ArrowLeft': void this.rate('again'); return true;
      case 'ArrowDown': void this.rate('hard'); return true;
      case 'ArrowRight': void this.rate('good'); return true;
      case 'ArrowUp': void this.master(); return true;
      case 'h': case 'H': return this.applyHint();
      default: return false;
    }
  }

  setBook(bookId: string): void {
    this.bookId = bookId;
    this.streak = 0;
    this.startSession();
  }

  private get current(): SessionItem | null {
    return this.queue[this.idx] ?? null;
  }

  private book() {
    return this.bookId ? this.plugin.store.getBook(this.bookId) : undefined;
  }

  startSession(): void {
    const book = this.book();
    const pro = this.plugin.license.pro;
    this.queue = book
      ? buildSession(book, this.plugin.log, new Date(), pro ? undefined : (m) => !isProReviewMode(m))
      : [];
    if (!pro && book?.reviewConfig.modes.some((m) => isProReviewMode(m))) {
      new Notice('高级复习模式属于 Lexora Pro，本次会话仅使用基础模式。', 5000);
    }
    this.idx = 0;
    this.doneNew = 0;
    this.doneReview = 0;
    this.finished = this.queue.length === 0;
    this.prepareCard();
    this.render();
  }

  private prepareCard(): void {
    this.revealed = false;
    this.answeredCorrect = null;
    const item = this.current;
    const cfg = this.book()?.reviewConfig;
    if (!item) return;
    const silent = item.mode === 'spelling' || item.mode === 'cloze-spell';
    const mustHear = item.mode === 'listening' || item.mode === 'listening-spell';
    if (mustHear || (cfg?.autoPronounce && !silent)) pronounce(item.card.lemma);
    void this.enrichSnapshot(item.card);
  }

  /** 卡片缺快照（无释义/词典例句）时静默补全：本地词库 → 在线词典兜底。 */
  private async enrichSnapshot(card: WordCard): Promise<void> {
    const hasCjk = card.senses.some((x) => /[\u4e00-\u9fff]/.test(x));
    if (card.senses.length > 0 && hasCjk && (card.dictExamples?.length ?? 0) > 0) return;
    let entry = (await this.plugin.dict.isReady()) ? await this.plugin.dict.lookup(card.lemma) : null;
    if (!entry || entry.senses.length === 0 || !entry.senses.some((x) => /[\u4e00-\u9fff]/.test(x))) {
      const online = await lookupOnline(card.lemma);
      if (online) entry = online;
    }
    if (!entry) return;
    const changed = await this.plugin.store.refreshSnapshot(card.lemma, entry);
    if (changed && this.current?.card.lemma === card.lemma) this.render();
  }

  /** 拼写类题提示首字母：填入首字母并聚焦输入框。返回是否消费按键。 */
  private hintApplier: (() => void) | null = null;

  private applyHint(): boolean {
    if (!this.hintApplier) return false;
    this.hintApplier();
    return true;
  }

  private onSpace(): void {
    const item = this.current;
    if (!item || this.finished) return;
    if (!this.revealed && item.mode === 'card') { this.revealed = true; this.render(); }
    else pronounce(item.card.lemma);
  }

  private async master(): Promise<void> {
    this.streak += 1;
    const item = this.current;
    if (!item || this.finished) return;
    await this.plugin.store.setMastered(item.card.lemma, true);
    await this.logAndAdvance(item);
  }

  private async rate(rating: ReviewRating): Promise<void> {
    if (this.revealed || this.current?.mode === 'card') this.streak = rating === 'again' ? 0 : this.streak + 1;
    const item = this.current;
    if (!item || this.finished) return;
    if (!this.revealed && item.mode !== 'card') return;
    if (!this.revealed && item.mode === 'card' && rating !== 'again') return;
    await this.plugin.store.applyRating(item.card.lemma, rating);
    await this.logAndAdvance(item);
  }

  private async logAndAdvance(item: SessionItem): Promise<void> {
    if (item.kind === 'new') this.doneNew++; else this.doneReview++;
    const stats = this.bookId ? this.plugin.store.stats(this.bookId) : null;
    const pct = stats?.total ? Math.round((stats.mastered / stats.total) * 1000) / 10 : undefined;
    await this.plugin.log.record(this.bookId ?? '', item.kind, pct);
    this.idx++;
    if (!this.current) this.finished = true;
    else this.prepareCard();
    this.plugin.refreshBooksViews();
    this.render();
  }

  // ---------------- rendering ----------------

  private render(): void {
    const root = this.root;
    if (!root) return;
    root.empty();
    root.addClass('elp-review');
    const book = this.book();
    if (!book) {
      root.createDiv({ cls: 'elp-sidebar-empty', text: '从「单词本」页点「开始学习」进入。' });
      return;
    }

    const head = root.createDiv({ cls: 'elp-review-head' });
    const back = iconButton(head, 'arrow-left', '返回词本', () => this.onBack());
    back.addClass('elp-review-back');
    const info = head.createDiv({ cls: 'elp-review-info' });
    info.createSpan({ cls: 'elp-review-bookname', text: book.name });
    const done = this.doneNew + this.doneReview;
    const total = this.queue.length;
    info.createSpan({
      cls: 'elp-review-count',
      text: `已完成 ${done} · 剩余 ${Math.max(0, total - done)}` + (this.streak >= 2 ? ` · 连对 ${this.streak} 🔥` : ''),
    });
    const barWrap = head.createDiv({ cls: 'elp-review-bar' });
    const bar = barWrap.createDiv({ cls: 'elp-review-bar-fill' });
    bar.style.width = total ? `${(done / total) * 100}%` : '0%';

    if (this.finished) { this.renderSummary(root); return; }
    const item = this.current!;

    const stage = root.createDiv({ cls: 'elp-review-stage' });
    switch (item.mode) {
      case 'card': this.renderCardMode(stage, item); break;
      case 'choice-meaning': this.renderChoiceMode(stage, item, 'sense', true); break;
      case 'listening': this.renderChoiceMode(stage, item, 'sense', false); break;
      case 'choice-word': this.renderChoiceMode(stage, item, 'word', false); break;
      case 'spelling': this.renderSpellingMode(stage, item, 'meaning'); break;
      case 'listening-spell': this.renderSpellingMode(stage, item, 'audio'); break;
      case 'cloze-spell': this.renderSpellingMode(stage, item, 'cloze'); break;
    }

    this.renderRatingBar(root, item);
    const keys = root.createDiv({ cls: 'elp-review-keys' });
    for (const k of ['Space 发音 / 翻面', 'H 提示首字母', '⏎ 提交', '← ↓ → ↑ 评分']) {
      keys.createSpan({ text: k });
    }
  }

  private wordHeader(parent: HTMLElement, card: WordCard, showWord = true): void {
    const head = parent.createDiv({ cls: 'elp-review-word-head' });
    if (showWord) head.createDiv({ cls: 'elp-review-word', text: card.lemma });
    const sub = head.createDiv({ cls: 'elp-review-sub' });
    if (showWord && card.phoneticUS) sub.createSpan({ cls: 'elp-popover-phonetic', text: `美 ${card.phoneticUS}` });
    iconButton(sub, 'volume-2', '发音（Space）', () => pronounce(card.lemma));
  }

  private renderExample(parent: HTMLElement, card: WordCard, hideWord: boolean): void {
    const cfg = this.book()!.reviewConfig;
    if (!cfg.showExample) return;
    const sentence = pickExample(card, cfg.randomExample);
    if (!sentence) return;
    const wrap = parent.createDiv({ cls: 'elp-review-example-wrap' });
    const ex = wrap.createDiv({ cls: 'elp-review-example' });
    if (hideWord) {
      const masked = sentence.replace(
        new RegExp(`\\b(${[card.lemma, ...card.variants].join('|')})\\b`, 'gi'), '____',
      );
      ex.setText(masked);
    } else {
      renderSentence(ex, sentence, card.lemma, card.variants);
    }
    if (!hideWord) {
      iconButton(wrap, 'volume-2', '朗读例句', () => pronounce(sentence), 'elp-example-speak');
    }
  }

  /** 答案区：释义 + 英文释义 + 标签 + 全部例句（带发音）。 */
  private renderAnswer(parent: HTMLElement, card: WordCard): void {
    const ans = parent.createDiv({ cls: 'elp-review-answer' });
    const ul = ans.createEl('ul', { cls: 'elp-card-senses' });
    for (const s of card.senses.slice(0, 5)) ul.createEl('li', { text: s });
    if (card.definitionEn?.length) ans.createDiv({ cls: 'elp-popover-defen', text: card.definitionEn[0] });
    if (card.tags.length) {
      const tags = ans.createDiv({ cls: 'elp-card-tags' });
      for (const t of card.tags.slice(0, 6)) tags.createSpan({ cls: 'elp-tag', text: t });
    }

    const examples: Array<{ en: string; sub?: string; path?: string }> = [
      ...card.contexts.slice(-1).map((c) => ({
        en: c.sentence,
        sub: c.sourceTitle ? `— ${c.sourceTitle}` : undefined,
        path: c.sourcePath,
      })),
      ...(card.dictExamples ?? []).slice(0, 2).map((e) => ({ en: e.en, sub: e.zh })),
    ];
    for (const ex of examples) {
      const row = ans.createDiv({ cls: 'elp-popover-example elp-dict-example' });
      const main = row.createDiv({ cls: 'elp-popover-example-main' });
      const sent = main.createDiv({ cls: 'elp-popover-sentence' });
      renderSentence(sent, ex.en, card.lemma, card.variants);
      iconButton(main, 'volume-2', '朗读例句', () => pronounce(ex.en), 'elp-example-speak');
      if (ex.sub) {
        const src = row.createDiv({ cls: 'elp-popover-source' });
        src.createSpan({ text: ex.sub });
        if (ex.path) {
          const link = src.createEl('a', { cls: 'elp-source-link', text: ' 回看原文 ↗', href: '#' });
          link.onclick = (e) => {
            e.preventDefault();
            void this.app.workspace.openLinkText(ex.path!, '', true);
          };
        }
      }
    }
  }

  private renderCardMode(stage: HTMLElement, item: SessionItem): void {
    this.wordHeader(stage, item.card);
    this.renderExample(stage, item.card, false);
    if (!this.revealed) {
      const btn = stage.createEl('button', { cls: 'elp-reveal-btn', text: '显示释义（Space）' });
      btn.onclick = () => { this.revealed = true; this.render(); };
    } else {
      this.renderAnswer(stage, item.card);
    }
  }

  private renderChoiceMode(
    stage: HTMLElement, item: SessionItem, field: 'sense' | 'word', showWord: boolean,
  ): void {
    const book = this.book()!;
    if (field === 'sense') {
      this.wordHeader(stage, item.card, showWord);
      if (showWord) this.renderExample(stage, item.card, false);
    } else {
      const q = stage.createDiv({ cls: 'elp-review-question' });
      for (const s of item.card.senses.slice(0, 2)) q.createDiv({ cls: 'elp-review-question-line', text: s });
      this.renderExample(stage, item.card, true);
    }

    const opts = buildChoices(item.card, book.cards, field);
    const wrap = stage.createDiv({ cls: 'elp-choice-grid' });
    for (const opt of opts) {
      const btn = wrap.createEl('button', { cls: 'elp-choice', text: opt.text });
      if (this.revealed) {
        btn.setAttr('disabled', 'true');
        if (opt.correct) btn.addClass('is-correct');
        else if (this.answeredCorrect === false) btn.addClass('is-dim');
      } else {
        btn.onclick = () => {
          this.answeredCorrect = opt.correct;
          this.revealed = true;
          this.render();
        };
      }
    }
    if (this.revealed) {
      if (!showWord) this.wordHeader(stage, item.card);
      this.renderAnswer(stage, item.card);
    }
  }

  private renderSpellingMode(
    stage: HTMLElement, item: SessionItem, variant: 'meaning' | 'audio' | 'cloze',
  ): void {
    if (variant === 'audio') {
      const q = stage.createDiv({ cls: 'elp-review-question elp-review-audio' });
      const big = q.createEl('button', { cls: 'elp-audio-big', attr: { 'aria-label': '重听发音（Space）' } });
      setIcon(big.createSpan(), 'volume-2');
      big.onclick = () => pronounce(item.card.lemma);
      if (item.card.phoneticUS) q.createDiv({ cls: 'elp-popover-phonetic', text: `美 ${item.card.phoneticUS}` });
      q.createDiv({ cls: 'elp-review-question-line', text: '听音拼写' });
    } else if (variant === 'cloze') {
      const q = stage.createDiv({ cls: 'elp-review-question' });
      this.renderExample(q, item.card, true);
      for (const s of item.card.senses.slice(0, 1)) {
        q.createDiv({ cls: 'elp-popover-phonetic', text: s });
      }
    } else {
      const q = stage.createDiv({ cls: 'elp-review-question' });
      for (const s of item.card.senses.slice(0, 2)) q.createDiv({ cls: 'elp-review-question-line', text: s });
      if (item.card.phoneticUS) q.createDiv({ cls: 'elp-popover-phonetic', text: `美 ${item.card.phoneticUS}` });
      this.renderExample(stage, item.card, true);
    }

    if (!this.revealed) {
      const form = stage.createDiv({ cls: 'elp-spell-form' });
      const lemma = item.card.lemma;
      const useBoxes = lemma.length <= 16;
      const input = form.createEl('input', {
        cls: useBoxes ? 'elp-spell-ghost' : 'elp-spell-input',
        attr: { type: 'text', placeholder: useBoxes ? '' : '输入单词，回车检查', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', maxlength: String(lemma.length + 8) },
      });
      let boxes: HTMLElement[] = [];
      if (useBoxes) {
        // 字母格：隐形输入框承接键入，格子只负责展示
        const grid = form.createDiv({ cls: 'elp-spell-boxes' });
        boxes = [...lemma].map((ch) => grid.createSpan({
          cls: 'elp-spell-box' + (ch === ' ' ? ' is-space' : ''),
          text: ch === ' ' ? ' ' : '',
        }));
        const paint = () => {
          const v = input.value;
          boxes.forEach((b, i) => {
            if (lemma[i] === ' ') return;
            b.setText(v[i] ?? '');
            b.toggleClass('is-filled', i < v.length);
            b.toggleClass('is-cursor', i === v.length);
          });
        };
        input.addEventListener('input', paint);
        grid.onclick = () => input.focus();
        paint();
      }
      const check = () => {
        this.answeredCorrect = input.value.trim().toLowerCase() === lemma.toLowerCase();
        this.revealed = true;
        this.hintApplier = null;
        pronounce(lemma);
        this.render();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
      const actions = form.createDiv({ cls: 'elp-spell-actions' });
      const hintBtn = actions.createEl('button', { cls: 'elp-spell-hint', text: `提示首字母 H` });
      this.hintApplier = () => {
        if (!input.value) {
          input.value = lemma[0];
          input.dispatchEvent(new Event('input'));
        }
        input.focus();
      };
      hintBtn.onclick = () => this.applyHint();
      const btn = actions.createEl('button', { cls: 'mod-cta', text: '检查 ⏎' });
      btn.onclick = check;
      window.setTimeout(() => input.focus(), 30);
    } else {
      const verdict = stage.createDiv({
        cls: `elp-spell-verdict ${this.answeredCorrect ? 'is-correct' : 'is-wrong'}`,
        text: this.answeredCorrect ? '拼写正确' : '再记一下',
      });
      verdict.createSpan({ cls: 'elp-review-word elp-spell-answer', text: item.card.lemma });
      this.renderAnswer(stage, item.card);
    }
  }

  private renderRatingBar(root: HTMLElement, item: SessionItem): void {
    const bar = root.createDiv({ cls: 'elp-rating-bar' });
    const canRate = this.revealed || item.mode === 'card';
    const suggest: ReviewRating | null =
      this.answeredCorrect === null ? null : this.answeredCorrect ? 'good' : 'again';

    const mk = (rating: ReviewRating, icon: string, label: string, key: string, cls: string) => {
      const btn = bar.createEl('button', { cls: `elp-rate ${cls}` });
      const ic = btn.createSpan({ cls: 'elp-rate-icon' });
      setIcon(ic, icon);
      btn.createSpan({ cls: 'elp-rate-label', text: label });
      btn.createSpan({ cls: 'elp-rate-key', text: key });
      if (!canRate && rating !== 'again') btn.setAttr('disabled', 'true');
      if (suggest === rating) btn.addClass('is-suggested');
      btn.onclick = () => void this.rate(rating);
      return btn;
    };
    mk('again', 'x', '不认识', '←', 'is-again');
    mk('hard', 'circle-dashed', '模糊', '↓', 'is-hard');
    mk('good', 'check', '认识', '→', 'is-good');

    const masterBtn = bar.createEl('button', { cls: 'elp-rate is-master' });
    const mic = masterBtn.createSpan({ cls: 'elp-rate-icon' });
    setIcon(mic, 'star');
    masterBtn.createSpan({ cls: 'elp-rate-label', text: '已掌握' });
    masterBtn.createSpan({ cls: 'elp-rate-key', text: '↑' });
    masterBtn.onclick = () => void this.master();
  }

  private renderSummary(root: HTMLElement): void {
    const box = root.createDiv({ cls: 'elp-review-summary' });
    const icon = box.createDiv({ cls: 'elp-summary-icon' });
    setIcon(icon, this.queue.length ? 'party-popper' : 'coffee');
    box.createDiv({
      cls: 'elp-summary-title',
      text: this.queue.length ? '今日任务完成！' : '今天没有要复习的词',
    });
    if (this.queue.length) {
      box.createDiv({
        cls: 'elp-summary-line',
        text: `本次 ${this.queue.length} 张：新词 ${this.doneNew} · 复习 ${this.doneReview}`,
      });
    }
    const actions = box.createDiv({ cls: 'elp-summary-actions' });
    const backBtn = actions.createEl('button', { cls: 'mod-cta', text: '返回词本页' });
    backBtn.onclick = () => this.onBack();
    const again = actions.createEl('button', { text: '再查一次队列' });
    again.onclick = () => this.startSession();
  }
}
