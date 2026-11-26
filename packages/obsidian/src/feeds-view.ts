import { cutWorksheet } from './article-clean';
import { bilibiliWatchUrl, fetchBiliSubtitle, fetchSpaceFeed, parseBilibiliSpace } from './bilibili';
import { cachedRecommended, refreshRecommended, renderLibrarySection } from './official';
import { App, Modal, Notice, Setting, TFile, requestUrl, setIcon } from 'obsidian';
import { overseasState, probeOverseas, ytGet } from './yt-net';
import {
  extractVideoId, htmlToText, normalizeFeedUrl, parseFeed, parseYoutubeChannelPage, youtubeWatchUrl,
  type FeedConfig, type FeedItem, type ParsedFeed,
} from '@elp/core';
import type ElpPlugin from './main';
import { ConfirmModal, iconButton } from './ui';
import {
  deleteLesson, generateArticleOriginal, generateFromArticle, generateFromMedia, generateFromNote, generateFromYoutubeAudio, sniffPageAudio,
} from './generate';
import { Readability } from '@mozilla/readability';
import { SubtitlePickModal } from './subtitle-modal';
import { pickLocalMedia } from './local-media';
import { openPlayerPane } from './player-pane';
import { INVIDIOUS_MIRRORS, fetchYoutubeSubtitle } from './yt-subs';

/** 把 feed 正文 HTML 清洗后渲染（去脚本/内联事件/js 链接，外链新窗口打开）。 */
function renderSafeHtml(parent: HTMLElement, html: string): void {
  // 有些 feed 的 CDATA 终结符会泄漏进正文
  const doc = new DOMParser().parseFromString(html.replace(/\]\]>/g, ''), 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta').forEach((n) => n.remove());
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if ((name === 'href' || name === 'src') && attr.value.trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
    if (el instanceof HTMLAnchorElement) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener');
    }
  }
  parent.append(...Array.from(doc.body.childNodes));
}

/** 订阅中心面板（挂在 Lexora 主页的一个内部 tab 里）。 */
export class FeedsPanel {
  private root!: HTMLElement;
  private selectedId: string | null = null;
  private items: FeedItem[] = [];
  private loading = false;
  /** 非空 = 阅读详情模式。 */
  private detail: FeedItem | null = null;

  constructor(private plugin: ElpPlugin, private app: App) {}

  mount(root: HTMLElement): void {
    this.root = root;
    this.render();
    const first = this.plugin.feeds.list()[0];
    if (first && !this.selectedId) void this.select(first.id);
  }

  requestRefresh(): void {
    if (this.root) this.render();
  }

  private async select(id: string): Promise<void> {
    this.selectedId = id;
    this.detail = null;
    await this.refreshItems();
  }

  private async refreshItems(): Promise<void> {
    const feed = this.plugin.feeds.list().find((f) => f.id === this.selectedId);
    if (!feed) { this.items = []; this.render(); return; }
    this.loading = true;
    this.render();
    try {
      let parsed: ParsedFeed | null = null;
      if (feed.kind === 'bilibili') {
        const mid = parseBilibiliSpace(feed.url);
        if (!mid) throw new Error('识别不出 UP 主 ID');
        parsed = await fetchSpaceFeed(this.plugin, mid);
      } else {
        const res = feed.kind === 'youtube'
          ? await ytGet(this.plugin, feed.url)
          : await requestUrl({ url: feed.url, headers: { 'user-agent': 'Mozilla/5.0' }, throw: false });
        parsed = res.status < 400 ? parseFeed(res.text) : null;
        // YouTube 的 videos.xml 端点时常 404：抓频道页兜底
        if ((!parsed || parsed.items.length === 0) && feed.kind === 'youtube') {
          parsed = await scrapeYoutubeChannel(this.plugin, feed.url);
        }
        if (!parsed) throw new Error(`HTTP ${res.status}`);
      }
      this.items = parsed.items;
    } catch (e) {
      this.items = [];
      new Notice(`拉取失败：${(e as Error).message}`);
    }
    this.loading = false;
    this.render();
  }

  private render(): void {
    const root = this.root;
    root.empty();
    root.addClass('elp-feeds');

    const feeds = this.plugin.feeds.list();

    if (this.detail) {
      this.renderDetail(root, feeds.find((f) => f.id === this.selectedId), this.detail);
      return;
    }

    // 工具栏：订阅 chips + 添加/刷新 + 本地来源入口
    const bar = root.createDiv({ cls: 'elp-feeds-bar' });
    for (const f of feeds) {
      const chip = bar.createEl('button', {
        cls: 'elp-books-tab' + (f.id === this.selectedId ? ' is-active' : ''),
        text: f.kind === 'youtube' ? `▶ ${f.name}` : f.name,
      });
      chip.onclick = () => void this.select(f.id);
      chip.oncontextmenu = async (e) => {
        e.preventDefault();
        if (window.confirm(`删除订阅「${f.name}」？`)) {
          await this.plugin.feeds.remove(f.id);
          if (this.selectedId === f.id) this.selectedId = null;
          this.render();
        }
      };
    }
    iconButton(bar, 'plus', '添加来源（订阅 / 本地）', () => new AddFeedModal(this.app, this.plugin, () => {
      this.render();
      const latest = this.plugin.feeds.list().at(-1);
      if (latest) void this.select(latest.id);
    }).open(), 'elp-books-add');
    if (this.selectedId) iconButton(bar, 'refresh-cw', '刷新', () => void this.refreshItems());

    const feed = feeds.find((f) => f.id === this.selectedId);
    if (!feed) {
      root.createDiv({
        cls: 'elp-sidebar-empty',
        text: feeds.length ? '选择一个订阅源，或用右侧按钮从本地内容生成教程。' : '还没有订阅。点 + 添加 RSS 或 YouTube 频道；也可以直接用本地媒体/当前笔记生成教程。',
      });
      return;
    }

    if (this.loading) { root.createDiv({ cls: 'elp-sidebar-empty', text: '加载中…' }); return; }

    const grid = root.createDiv({ cls: 'elp-feed-grid' });
    for (const item of this.items) {
      const card = grid.createDiv({ cls: 'elp-card' });
      card.onclick = () => { this.detail = item; this.render(); };

      // 封面 / 文字摘要兜底
      if (item.image) {
        const cover = card.createDiv({ cls: 'elp-card-cover' });
        cover.style.backgroundImage = `url("${item.image.replace(/"/g, '%22')}")`;
      } else {
        const snip = htmlToText(item.contentHtml ?? item.summary ?? '').trim().slice(0, 160);
        card.createDiv({ cls: 'elp-card-snippet', text: snip || '（无摘要）' });
      }

      const body = card.createDiv({ cls: 'elp-card-body' });
      body.createDiv({ cls: 'elp-card-title', text: item.title || '(无标题)' });
      const meta = body.createDiv({ cls: 'elp-card-meta' });
      if (item.videoId) meta.createSpan({ cls: 'elp-tag', text: '视频' });
      else if (item.bvid) meta.createSpan({ cls: 'elp-tag', text: '视频' });
      else if (item.audioUrl) meta.createSpan({ cls: 'elp-tag', text: '音频' });
      if (item.published) meta.createSpan({ text: item.published.slice(0, 10) });
      else if (item.publishedText) meta.createSpan({ text: item.publishedText });
      const existing = this.plugin.feeds.lessonFor(item.id);
      if (existing) meta.createSpan({ cls: 'elp-tag is-done', text: '已生成' });

      const actions = body.createDiv({ cls: 'elp-card-actions' });
      this.buildItemActions(actions, feed, item, existing);
    }
    if (this.items.length === 0) {
      root.createDiv({ cls: 'elp-sidebar-empty', text: '没有条目（源可能暂时抓不到）。' });
    }
  }

  /** 生成/打开/删除按钮组（卡片与详情页共用）。 */
  private buildItemActions(
    parent: HTMLElement, feed: FeedConfig, item: FeedItem, existing: string | undefined,
  ): void {
    if (existing) {
      const open = parent.createEl('button', { cls: 'elp-books-tab', text: '打开教程' });
      open.onclick = (e) => {
        e.stopPropagation();
        const f = this.app.vault.getAbstractFileByPath(existing);
        if (f instanceof TFile) void this.app.workspace.getLeaf(true).openFile(f, { state: { mode: 'preview' } });
        else new Notice('教程文件不存在（可能已移动）');
      };
      iconButton(parent, 'trash-2', '删除教程（学习笔记+切片+录音）', () =>
        new ConfirmModal(
          this.app, '删除教程',
          `删除「${item.title}」的学习笔记、切片和录音？文件会移入系统回收站，可找回。`,
          '删除',
          () => void deleteLesson(this.plugin, existing).then(() => this.render()),
        ).open(), 'elp-row-del');
    } else {
      const gen = parent.createEl('button', { cls: 'mod-cta elp-gen-btn', text: '生成教程' });
      gen.onclick = (e) => { e.stopPropagation(); void this.generate(feed, item); };
    }
  }

  /** 详情阅读页：标题 + 视频/封面 + 正文 + 操作。 */
  private renderDetail(root: HTMLElement, feed: FeedConfig | undefined, item: FeedItem): void {
    const head = root.createDiv({ cls: 'elp-reader-head' });
    iconButton(head, 'arrow-left', '返回列表', () => { this.detail = null; this.render(); });
    head.createDiv({ cls: 'elp-reader-title', text: item.title || '(无标题)' });
    const acts = head.createDiv({ cls: 'elp-reader-acts' });
    if (item.link) iconButton(acts, 'external-link', '打开原文', () => window.open(item.link, '_blank'));
    if (feed) this.buildItemActions(acts, feed, item, this.plugin.feeds.lessonFor(item.id));

    const body = root.createDiv({ cls: 'elp-reader-body' });
    const meta = body.createDiv({ cls: 'elp-reader-meta' });
    if (feed) meta.createSpan({ text: feed.name });
    if (item.published) meta.createSpan({ text: new Date(item.published).toLocaleDateString() });
    else if (item.publishedText) meta.createSpan({ text: item.publishedText });
    if (item.audioUrl) meta.createSpan({ cls: 'elp-tag', text: '含原声音频' });

    if (item.videoId || item.bvid || item.audioUrl) {
      // 媒体封面 + 大播放键 → 在右侧播放器面板打开
      const mediaCard = body.createDiv({ cls: 'elp-reader-media' });
      if (item.image) mediaCard.style.backgroundImage = `url("${item.image.replace(/"/g, '%22')}")`;
      else mediaCard.addClass('no-cover');
      const overlay = mediaCard.createDiv({ cls: 'elp-reader-media-overlay' });
      const big = overlay.createEl('button', { cls: 'elp-reader-media-play', attr: { 'aria-label': '在播放器中打开' } });
      setIcon(big.createSpan(), 'play');
      overlay.createDiv({
        cls: 'elp-reader-media-hint',
        text: item.videoId || item.bvid ? '在右侧播放器中观看' : '在右侧播放器中收听',
      });
      mediaCard.onclick = () => {
        void openPlayerPane(this.plugin).then((pane) => pane?.showMedia({
          title: item.title,
          subtitle: feed?.name,
          cover: item.image,
          videoId: item.videoId,
          bvid: item.bvid,
          audioUrl: item.audioUrl,
        }));
      };
    } else if (item.image) {
      const hero = body.createDiv({ cls: 'elp-reader-hero' });
      hero.createEl('img', { attr: { src: item.image } });
    }

    // BBC 等站点：feed 里没挂音频，但页面里有 mp3 → 后台嗅探后补出播放卡片
    if (!item.videoId && !item.audioUrl && item.link) {
      const probe = body.createDiv({ cls: 'elp-muted', text: '正在检测这期是否有原声音频…' });
      void sniffPageAudio(item.link).then((url) => {
        if (this.detail !== item) return;
        if (!url) { probe.remove(); return; }
        item.audioUrl = url;
        this.render();
      });
    }

    const content = body.createDiv({ cls: 'elp-reader-content' });
    const html = cutWorksheet(item.contentHtml ?? item.summary ?? '', item.link);
    if (html.trim()) renderSafeHtml(content, html);
    const plainLen = htmlToText(html).trim().length;
    // NPR 这类 feed 只给一两句摘要：从原文页用 Readability 抽全文补上
    if (!item.videoId && item.link && plainLen < 600) {
      const note = content.createDiv({ cls: 'elp-muted', text: '正在从原文加载全文…' });
      void (async () => {
        try {
          const res = await requestUrl({ url: item.link, headers: { 'user-agent': 'Mozilla/5.0' } });
          const doc = new DOMParser().parseFromString(res.text, 'text/html');
          const article = new Readability(doc).parse();
          if (this.detail !== item) return;
          if (article?.content && (article.textContent?.trim().length ?? 0) > plainLen + 200) {
            content.empty();
            renderSafeHtml(content, cutWorksheet(article.content, item.link));
          } else {
            note.setText(plainLen === 0 ? '这条没有正文，点右上角打开原文阅读。' : '');
            if (plainLen > 0) note.remove();
          }
        } catch {
          if (this.detail === item) note.remove();
        }
      })();
    } else if (!html.trim()) {
      content.createDiv({ cls: 'elp-muted', text: '这条没有正文，点右上角打开原文阅读。' });
    }
  }

  private async generate(feed: FeedConfig, item: FeedItem): Promise<void> {
    if (item.bvid) {
      const bvid = item.bvid;
      const probing = new Notice('获取 B 站 CC 字幕…', 0);
      const sub = await fetchBiliSubtitle(this.plugin, bvid).catch(() => null);
      probing.hide();
      const vtt = sub?.vtt ?? null;
      if (vtt) {
        await generateFromMedia(this.plugin, {
          title: item.title,
          media: { kind: 'bilibili', bvid, cid: sub?.cid },
          subtitleText: vtt,
          sourceUrl: bilibiliWatchUrl(bvid),
          feedName: feed.name,
          itemId: item.id,
        });
        this.render();
        return;
      }
      new Notice(
        '该视频没有可用的 CC 字幕' +
        (this.plugin.settings.bilibiliSessdata ? '' : '（部分字幕需登录：设置 → Bilibili 填 SESSDATA 后重试）') +
        '，也可手动选字幕文件',
        8000,
      );
      new SubtitlePickModal(this.app, this.plugin, async (subFile) => {
        await generateFromMedia(this.plugin, {
          title: item.title,
          media: { kind: 'bilibili', bvid, cid: sub?.cid },
          subtitleFile: subFile,
          sourceUrl: bilibiliWatchUrl(bvid),
          feedName: feed.name,
          itemId: item.id,
        });
        this.render();
      }).open();
      return;
    }
    if (feed.kind === 'youtube' || item.videoId) {
      const videoId = item.videoId ?? (item.link ? extractVideoId(item.link) : null);
      if (!videoId) { new Notice('识别不出视频 ID'); return; }

      // 自动拉取该视频自带字幕（人工优先，ASR 兜底）；失败才手动选
      const probing = new Notice('获取视频字幕…', 0);
      const vtt = await fetchYoutubeSubtitle(this.plugin, videoId);
      probing.hide();
      if (vtt) {
        // 首选完整管线（同旧套件）：worker 下载音轨 → 本地对齐 → 自动切片
        const caps = await this.plugin.worker.capabilities();
        if (caps?.features?.ytaudio && caps.features.clip) {
          await generateFromYoutubeAudio(this.plugin, {
            title: item.title,
            videoId,
            vtt,
            sourceUrl: youtubeWatchUrl(videoId),
            feedName: feed.name,
            itemId: item.id,
          });
        } else {
          // 无 worker：退化为内嵌视频跳句（无切片）
          await generateFromMedia(this.plugin, {
            title: item.title,
            media: { kind: 'youtube', videoId },
            subtitleText: vtt,
            sourceUrl: youtubeWatchUrl(videoId),
            feedName: feed.name,
            itemId: item.id,
          });
        }
        this.render();
        return;
      }
      new Notice('这个视频拉不到字幕，手动选一个字幕文件（时间轴必须对应本视频）');
      new SubtitlePickModal(this.app, this.plugin, async (sub) => {
        await generateFromMedia(this.plugin, {
          title: item.title,
          media: { kind: 'youtube', videoId },
          subtitleFile: sub,
          sourceUrl: youtubeWatchUrl(videoId),
          feedName: feed.name,
          itemId: item.id,
        });
        this.render();
      }).open();
    } else {
      let audioUrl = item.audioUrl;
      if (!audioUrl && item.link) {
        const probing = new Notice('检测原声音频…', 0);
        audioUrl = await sniffPageAudio(item.link);
        probing.hide();
      }
      if (audioUrl) {
        new ArticleGenModal(this.app, this.plugin, feed, item, audioUrl, () => this.render()).open();
        return;
      }
      await generateFromArticle(this.plugin, {
        title: item.title,
        url: item.link,
        contentHtml: item.contentHtml,
        feedName: feed.name,
        itemId: item.id,
      });
      this.render();
    }
  }
}

/** 带原声的文章条目：原声教程（转写对齐）或文本教程（整段播放器）。 */
class ArticleGenModal extends Modal {
  constructor(
    app: App,
    private plugin: ElpPlugin,
    private feed: FeedConfig,
    private item: FeedItem,
    private audioUrl: string,
    private onDone: () => void,
  ) { super(app); }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '这期自带原声音频' });
    contentEl.createDiv({ cls: 'elp-muted', text: this.item.title });

    const caps = await this.plugin.worker.capabilities();
    const canTranscribe = !!caps?.features.transcribe;

    new Setting(contentEl)
      .setName('原声教程（推荐）')
      .setDesc(canTranscribe
        ? '下载 mp3 → 伴侣服务转写 → 句级原声跟读与跳转'
        : '需要伴侣服务（设置 → Lexora → 伴侣服务）')
      .addButton((b) => {
        b.setButtonText('生成').setCta().onClick(() => {
          this.close();
          void generateArticleOriginal(this.plugin, {
            title: this.item.title,
            url: this.item.link,
            audioUrl: this.audioUrl,
            feedName: this.feed.name,
            itemId: this.item.id,
          }).then(this.onDone);
        });
        if (!canTranscribe) b.setDisabled(true);
      });

    new Setting(contentEl)
      .setName('文本教程')
      .setDesc('抓网页正文；顶部内嵌整段原声播放器，句子 ▶ 用 TTS')
      .addButton((b) => b.setButtonText('生成').onClick(() => {
        this.close();
        void generateFromArticle(this.plugin, {
          title: this.item.title,
          url: this.item.link,
          contentHtml: this.item.contentHtml,
          audioUrl: this.audioUrl,
          feedName: this.feed.name,
          itemId: this.item.id,
        }).then(this.onDone);
      }));
  }

  onClose(): void { this.contentEl.empty(); }
}

/** 一键订阅的推荐源（英语学习播客 / YouTube 频道 / 博客）。 */
const PRESET_FEEDS: Array<{ name: string; url: string; hint: string }> = [
  { name: 'BBC 6 Minute English', url: 'https://podcasts.files.bbci.co.uk/p02pc9tn.rss', hint: '播客 · 中级' },
  { name: 'BBC The English We Speak', url: 'https://podcasts.files.bbci.co.uk/p02pc9zn.rss', hint: '播客 · 地道短语' },
  { name: 'NPR News Now', url: 'https://feeds.npr.org/500005/podcast.xml', hint: '播客 · 新闻' },
  { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', hint: '文章 · 新闻' },
  { name: "Luke's English Podcast", url: 'https://teacherluke.co.uk/feed/podcast/', hint: '播客 · 长对话' },
  { name: 'All Ears English', url: 'https://allearsenglish.libsyn.com/rss', hint: '播客 · 美式口语' },
  { name: 'Speak English With Vanessa', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxJGMJbjokfnr2-s4_RXPxQ', hint: 'YouTube' },
  { name: 'Easy English', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCTRHegh7UqWuKRymXoqzbzA', hint: 'YouTube · 街访' },
  { name: "Rachel's English", url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvn_XCl_mgQmt3sD753zdJA', hint: 'YouTube · 发音' },
  { name: 'Engineering at Meta', url: 'https://engineering.fb.com/feed/', hint: '博客 · 技术' },
];


/** videos.xml 不可用时的兜底链：官方频道页抓取 → Invidious 镜像 feed。 */
async function scrapeYoutubeChannel(plugin: ElpPlugin, feedUrl: string): Promise<ParsedFeed | null> {
  const m = feedUrl.match(/channel_id=(UC[\w-]{10,})/);
  if (!m) return null;
  const id = m[1];

  // 1) 官方频道 /videos 页
  try {
    const res = await ytGet(plugin, `https://www.youtube.com/channel/${id}/videos?hl=en`);
    if (res.status < 400) {
      const parsed = parseYoutubeChannelPage(res.text);
      if (parsed.items.length > 0) return parsed;
    }
  } catch { /* 继续走镜像 */ }

  // 2) Invidious 镜像的 Atom feed（条目带 yt:videoId，封面用官方缩略图）
  for (const base of INVIDIOUS_MIRRORS) {
    try {
      const res = await ytGet(plugin, `${base}/feed/channel/${id}`);
      if (res.status < 400) {
        const parsed = parseFeed(res.text);
        if (parsed.items.length > 0) return { ...parsed, kind: 'youtube' };
      }
    } catch { /* 下一个镜像 */ }
  }
  return null;
}

/** @handle / /c/ / /user/ 形式的 YouTube 链接：抓页面解析出 channel_id。 */
async function resolveFeedUrl(plugin: ElpPlugin, input: string): Promise<string> {
  const n = normalizeFeedUrl(input);
  if (n !== input) return n;
  if (/youtube\.com\/(@|c\/|user\/)/.test(input)) {
    const res = await ytGet(plugin, input);
    const m = res.text.match(/"channelId":"(UC[\w-]{10,})"/)
      ?? res.text.match(/channel_id=(UC[\w-]{10,})/);
    if (m) return `https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}`;
    throw new Error('识别不出频道 ID，试试频道主页的 /channel/UC… 链接');
  }
  return n;
}

class AddFeedModal extends Modal {
  private url = '';
  private name = '';

  constructor(app: App, private plugin: ElpPlugin, private onAdded: () => void) {
    super(app);
  }

  /** 解析地址 → 拉取校验 → 入库。被手动添加与推荐源共用。 */
  private async addFeed(rawUrl: string, name?: string): Promise<boolean> {
    let url = rawUrl;
    try {
      const mid = parseBilibiliSpace(rawUrl);
      if (mid) {
        const parsed = await fetchSpaceFeed(this.plugin, mid);
        await this.plugin.feeds.add({
          name: name || parsed.title,
          url: `https://space.bilibili.com/${mid}`,
          kind: 'bilibili',
        });
        new Notice(`已订阅：${name || parsed.title}（${parsed.items.length} 条）`);
        this.onAdded();
        return true;
      }
      url = await resolveFeedUrl(this.plugin, rawUrl);
      const res = /youtube\.com/.test(url)
        ? await ytGet(this.plugin, url)
        : await requestUrl({ url, headers: { 'user-agent': 'Mozilla/5.0' }, throw: false });
      let parsed: ParsedFeed | null = res.status < 400 ? parseFeed(res.text) : null;
      if (parsed && parsed.items.length === 0 && !parsed.title) parsed = null;
      // YouTube RSS 端点 404 → 抓频道页验证并取标题
      if (!parsed && /youtube\.com\/feeds\/videos\.xml/.test(url)) {
        parsed = await scrapeYoutubeChannel(this.plugin, url);
      }
      if (!parsed) throw new Error(`HTTP ${res.status}`);
      await this.plugin.feeds.add({
        name: name || parsed.title || url,
        url,
        kind: parsed.kind,
      });
      new Notice(`已订阅：${name || parsed.title}（${parsed.items.length} 条）`);
      this.onAdded();
      return true;
    } catch (e) {
      new Notice(`订阅失败：${(e as Error).message}\n${url}`, 8000);
      return false;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '添加来源' });
    new Setting(contentEl)
      .setName('地址')
      .setDesc('RSS/Atom 链接、B 站 UP 主主页（space.bilibili.com/…），或 YouTube 频道页 /channel/UC… 链接。')
      .addText((t) => t.setPlaceholder('https://…').onChange((v) => { this.url = v.trim(); }));
    new Setting(contentEl)
      .setName('名称（可选）')
      .addText((t) => t.onChange((v) => { this.name = v.trim(); }));

    new Setting(contentEl).addButton((b) =>
      b.setButtonText('添加订阅').setCta().onClick(async () => {
        if (!this.url) return;
        if (await this.addFeed(this.url, this.name)) this.close();
      }),
    );

    // ---- 推荐源：一键订阅 ----
    const recHead = contentEl.createDiv({ cls: 'elp-modal-subhead' });
    setIcon(recHead.createSpan(), 'sparkles');
    recHead.createSpan({ text: '推荐源（点一下即订阅）' });
    const recWrap = contentEl.createDiv({ cls: 'elp-preset-grid' });
    const existingUrls = new Set(this.plugin.feeds.list().map((f) => f.url));
    const existingNames = new Set(this.plugin.feeds.list().map((f) => f.name.toLowerCase()));
    // 远端清单（控制台「推荐源」页维护，缓存 7 天）优先；拉不到回退内置
    const all = cachedRecommended(this.plugin) ?? PRESET_FEEDS;
    void refreshRecommended(this.plugin).then((changed) => {
      if (changed && this.contentEl.isConnected) { this.contentEl.empty(); this.onOpen(); }
    });
    // 境外源（YouTube 等）仅在本机网络可直连时展示；探测结果 30 分钟缓存
    const isOverseas = (f: { url: string; hint: string; region?: string }): boolean =>
      f.region === 'global' || (f.region !== 'cn' && /youtube\.com|youtu\.be/.test(f.url));
    const ok = overseasState();
    const presets = all.filter((f) => ok === true || !isOverseas(f));
    if (presets.length < all.length) {
      recWrap.createDiv({
        cls: 'elp-preset-note',
        text: ok === null ? '正在检测 YouTube 直连…可用时将显示境外源' : '已隐藏境外源（当前网络无法直连 YouTube；设置页可重新检测）',
      });
      if (ok === null) void probeOverseas(this.plugin).then(() => { if (this.contentEl.isConnected) { this.contentEl.empty(); this.onOpen(); } });
    }
    for (const p of presets) {
      const chip = recWrap.createEl('button', { cls: 'elp-preset' });
      chip.createSpan({ cls: 'elp-preset-name', text: p.name });
      chip.createSpan({ cls: 'elp-preset-hint', text: p.hint });
      if (existingUrls.has(p.url) || existingNames.has(p.name.toLowerCase())) {
        chip.addClass('is-added');
        chip.disabled = true;
      }
      chip.onclick = async () => {
        chip.disabled = true;
        chip.addClass('is-loading');
        const ok = await this.addFeed(p.url, p.name);
        chip.removeClass('is-loading');
        if (ok) chip.addClass('is-added');
        else chip.disabled = false;
      };
    }

    // ---- 精选课（公版内容库）----
    const libHead = contentEl.createDiv({ cls: 'elp-modal-subhead' });
    setIcon(libHead.createSpan(), 'book-audio');
    libHead.createSpan({ text: '精选课（公版内容库 · 试听免费）' });
    const libWrap = contentEl.createDiv({ cls: 'elp-lib-list' });
    libWrap.createDiv({ cls: 'elp-lib-empty', text: '加载中…' });
    void renderLibrarySection(this.plugin, libWrap, () => this.close());

    // ---- 从本地获取 ----
    const head = contentEl.createDiv({ cls: 'elp-modal-subhead' });
    setIcon(head.createSpan(), 'folder');
    head.createSpan({ text: '从本地获取' });
    new Setting(contentEl)
      .setName('本地媒体文件')
      .setDesc('从电脑或手机选音视频文件（任意位置），转写或配字幕后生成教程')
      .addButton((b) => b.setButtonText('选择').onClick(() => {
        this.close();
        pickLocalMedia(this.plugin);
      }));
    new Setting(contentEl)
      .setName('当前笔记')
      .setDesc('把编辑区打开的 Markdown 笔记变成教程')
      .addButton((b) => b.setButtonText('生成').onClick(() => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === 'md') {
          this.close();
          void generateFromNote(this.plugin, file);
        } else new Notice('先在编辑区打开一篇 Markdown 笔记');
      }));
  }

  onClose(): void { this.contentEl.empty(); }
}
