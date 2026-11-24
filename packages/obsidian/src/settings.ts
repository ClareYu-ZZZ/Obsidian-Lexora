import { App, FuzzySuggestModal, Modal, Notice, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import { TextInputModal } from './ui';
import type ElpPlugin from './main';
import { fetchOpenaiTts } from './audio';
import { TELEMETRY_ENDPOINT, checkForUpdate } from './telemetry';

export interface ElpSettings {
  /** Vault-relative path to the dictionary csv (ECDICT format). */
  dictCsvPath: string;
  /** Base folder for all plugin data inside the vault. */
  baseFolder: string;
  /** Folders in which highlighting is active; empty = whole vault. */
  highlightScopes: string[];
  /** Also highlight mastered words (dimmed style). */
  includeMastered: boolean;
  /** Blur definitions in hover cards until mouseover (active recall). */
  blurDefinitions: boolean;
  highlightStyle: 'underline' | 'background';
  defaultBookId: string;
  /** Path of a known-words txt for one-shot import. */
  knownWordsPath: string;
  /** Pronounce the word right after collecting it. */
  autoPronounce: boolean;
  /** ---- P2 content pipeline ---- */
  feedsFile: string;
  lessonsFolder: string;
  mineLevels: string;
  maxWordsVideo: number;
  maxWordsArticle: number;
  maxSentences: number;
  minRank: number;
  /** ---- P3 companion worker ---- */
  workerUrl: string;
  workerToken: string;
  /** Piper 音色（空=服务默认） */
  ttsVoice: string;
  /** 单词发音源：词典真人读音 / 伴侣服务 TTS / 系统语音。 */
  wordAudioSource: 'dict' | 'worker' | 'system';
  /** 句子朗读引擎：worker=Piper（NAS 本地），openai=OpenAI TTS（ChatGPT 同款，带语气）。 */
  ttsProvider: 'worker' | 'openai';
  openaiKey: string;
  openaiVoice: string;
  openaiModel: string;
  /** ---- 欧路同步 ---- */
  eudicToken: string;
  eudicCategoryId: string;
  eudicCategoryName: string;
  eudicAutoSync: boolean;
  /** 词汇量测试历史 */
  vocabTests: Array<{ date: string; estimate: number }>;
  /** ---- Lexora Pro ---- */
  licenseKey: string;
  /** Unix ms when the 14-day trial started; absent = not started. */
  trialStartedAt?: number;
  /** Monthly lesson-generation counter. */
  lessonUsage?: { month: string; used: number };
  /** ---- 更新与统计 ---- */
  updateCheckEnabled: boolean;
  telemetryEnabled: boolean;
  installId?: string;
  /** 官方推荐源缓存（控制台维护，7 天有效）。 */
  officialFeedsCache?: { at: number; feeds: Array<{ name: string; url: string; hint: string }> };
  lastUpdateCheckAt?: number;
  lastPingAt?: number;
  lastNotifiedVersion?: string;
}

export const DEFAULT_SETTINGS: ElpSettings = {
  dictCsvPath: '',
  baseFolder: 'English',
  highlightScopes: [],
  includeMastered: false,
  blurDefinitions: false,
  highlightStyle: 'underline',
  defaultBookId: '',
  knownWordsPath: '',
  autoPronounce: true,
  feedsFile: 'English/feeds.json',
  lessonsFolder: '50-Resources/Lexora',
  mineLevels: 'cet6,ky,toefl,ielts,gre',
  maxWordsVideo: 35,
  maxWordsArticle: 25,
  maxSentences: 12,
  minRank: 6000,
  workerUrl: '',
  workerToken: '',
  ttsVoice: '',
  wordAudioSource: 'dict',
  ttsProvider: 'worker',
  openaiKey: '',
  openaiVoice: 'nova',
  openaiModel: 'gpt-4o-mini-tts',
  eudicToken: '',
  eudicCategoryId: '',
  eudicCategoryName: '',
  eudicAutoSync: false,
  vocabTests: [],
  licenseKey: '',
  updateCheckEnabled: true,
  telemetryEnabled: true,
};

export function mineLevelsOf(s: ElpSettings): string[] {
  return s.mineLevels.split(',').map((x) => x.trim()).filter(Boolean);
}

export function booksFolder(s: ElpSettings): string {
  return `${s.baseFolder}/books`;
}

export function dictCacheFolder(s: ElpSettings): string {
  return `${s.baseFolder}/dict-cache`;
}

export function inScope(s: ElpSettings, path: string | undefined | null): boolean {
  if (!path || !path.endsWith('.md')) return false;
  // 排除插件数据子目录（词本/词库缓存/TTS 缓存），教程笔记本身要高亮
  for (const sub of ['books', 'dict-cache', 'tts-cache']) {
    if (path.startsWith(`${s.baseFolder}/${sub}/`)) return false;
  }
  // 教程目录始终高亮（生词表/长难句/全文都在这儿）
  const lessons = s.lessonsFolder.replace(/\/$/, '');
  if (lessons && (path === lessons || path.startsWith(lessons + '/'))) return true;
  if (s.highlightScopes.length === 0) return true;
  return s.highlightScopes.some((scope) => {
    const p = scope.trim().replace(/\/$/, '');
    return p !== '' && (path === p || path.startsWith(p + '/'));
  });
}

export class ElpSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ElpPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('Lexora Pro').setHeading();
    const licStatus = new Setting(containerEl)
      .setName('状态')
      .setDesc(`${this.plugin.license.statusText()} · ${this.plugin.license.quotaText()}`);
    licStatus.addButton((b) => b.setButtonText('刷新').onClick(async () => {
      await this.plugin.license.refresh();
      this.display();
    }));
    new Setting(containerEl)
      .setName('License key')
      .setDesc('购买后收到的 LEXORA1.… key（按月/按年订阅）。免费版永久可用；Pro 解锁 worker 高级功能、高级复习模式，教程生成额度 5→20 个/月。')
      .addText((t) => {
        t.setPlaceholder('LEXORA1.…')
          .setValue(this.plugin.settings.licenseKey)
          .onChange((v) => { this.plugin.settings.licenseKey = v.trim(); });
        t.inputEl.style.width = '100%';
      })
      .addButton((b) => b.setButtonText('应用').setCta().onClick(async () => {
        await this.plugin.saveSettings();
        const st = await this.plugin.license.refresh();
        new Notice(st.tier === 'pro' ? 'Pro 已激活 ✓' : (st.keyError ?? '未激活'));
        this.display();
      }));

    new Setting(containerEl).setName('词典').setHeading();

    new Setting(containerEl)
      .setName('词典 CSV 路径')
      .setDesc('vault 内的 ECDICT 格式 csv（插件不内置词库数据）。改动后需重建索引。')
      .addText((t) =>
        t.setPlaceholder('99-Meta/scripts/ecdict.csv')
          .setValue(this.plugin.settings.dictCsvPath)
          .onChange(async (v) => {
            this.plugin.settings.dictCsvPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    const dictStatus = new Setting(containerEl)
      .setName('词典索引')
      .setDesc('状态读取中…');
    void this.plugin.dict.meta().then((meta) => {
      dictStatus.setDesc(
        meta
          ? `已就绪：${meta.entries.toLocaleString()} 条，构建于 ${meta.builtAt.slice(0, 10)}`
          : '未构建。填好 csv 路径后点击右侧按钮。',
      );
    });
    dictStatus.addButton((b) =>
      b.setButtonText('重建索引').setCta().onClick(async () => {
        await this.plugin.rebuildDictIndex();
        this.display();
      }),
    );

    new Setting(containerEl).setName('高亮').setHeading();

    new Setting(containerEl)
      .setName('高亮范围')
      .setDesc('只在这些文件夹内高亮，每行一个；留空 = 全库（插件数据目录除外）。')
      .addTextArea((t) =>
        t.setPlaceholder('50-Resources/YouTube\n50-Resources/Articles\n20-Notes')
          .setValue(this.plugin.settings.highlightScopes.join('\n'))
          .onChange(async (v) => {
            this.plugin.settings.highlightScopes = v.split('\n').map((x) => x.trim()).filter(Boolean);
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          }),
      );

    new Setting(containerEl)
      .setName('高亮样式')
      .addDropdown((d) =>
        d.addOptions({ underline: '下划线', background: '背景色' })
          .setValue(this.plugin.settings.highlightStyle)
          .onChange(async (v) => {
            this.plugin.settings.highlightStyle = v as ElpSettings['highlightStyle'];
            await this.plugin.saveSettings();
            this.plugin.applyBodyClasses();
          }),
      );

    new Setting(containerEl)
      .setName('高亮已掌握的词')
      .setDesc('开启后已掌握的词以淡化样式显示，关闭则完全不高亮。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeMastered).onChange(async (v) => {
          this.plugin.settings.includeMastered = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        }),
      );

    new Setting(containerEl)
      .setName('悬停卡片模糊释义')
      .setDesc('先回忆，鼠标移到释义上才显示。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.blurDefinitions).onChange(async (v) => {
          this.plugin.settings.blurDefinitions = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('单词本').setHeading();

    new Setting(containerEl)
      .setName('默认单词本')
      .setDesc('右键快速收词的目标词本。')
      .addDropdown((d) => {
        for (const b of this.plugin.store.listBooks()) d.addOption(b.id, b.name);
        const cur = this.plugin.settings.defaultBookId;
        if (cur && this.plugin.store.getBook(cur)) d.setValue(cur);
        d.onChange(async (v) => {
          this.plugin.settings.defaultBookId = v;
          await this.plugin.saveSettings();
        });
      })
      .addButton((b) =>
        b.setButtonText('新建词本').onClick(async () => {
          const name = `新词本 ${this.plugin.store.listBooks().length + 1}`;
          await this.plugin.store.createBook(name);
          this.plugin.refreshAll();
          this.display();
          new Notice(`已创建「${name}」，可在词本文件中改名`);
        }),
      );

    new Setting(containerEl)
      .setName('收词后自动发音')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoPronounce).onChange(async (v) => {
          this.plugin.settings.autoPronounce = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('教程生成').setHeading();

    new Setting(containerEl)
      .setName('收词考试范围')
      .setDesc('逗号分隔：cet4,cet6,ky,toefl,ielts,gre；留空则纯按词频。')
      .addText((t) =>
        t.setValue(this.plugin.settings.mineLevels).onChange(async (v) => {
          this.plugin.settings.mineLevels = v.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('每篇生词上限（视频 / 文章）')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxWordsVideo)).onChange(async (v) => {
          this.plugin.settings.maxWordsVideo = parseInt(v, 10) || 35;
          await this.plugin.saveSettings();
        }),
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxWordsArticle)).onChange(async (v) => {
          this.plugin.settings.maxWordsArticle = parseInt(v, 10) || 25;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('长难句条数 / 词频阈值')
      .setDesc('词频排名超过阈值的罕见词即使不带考试标签也收。')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxSentences)).onChange(async (v) => {
          this.plugin.settings.maxSentences = parseInt(v, 10) || 12;
          await this.plugin.saveSettings();
        }),
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.minRank)).onChange(async (v) => {
          this.plugin.settings.minRank = parseInt(v, 10) || 6000;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('教程输出目录')
      .addText((t) =>
        t.setValue(this.plugin.settings.lessonsFolder).onChange(async (v) => {
          this.plugin.settings.lessonsFolder = v.trim() || '50-Resources/Lexora';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('伴侣服务（elp-worker）').setHeading();

    new Setting(containerEl)
      .setName('服务地址')
      .setDesc('NAS/本机上的 elp-worker，如 http://192.168.1.10:8321；无字幕媒体转写需要它。')
      .addText((t) =>
        t.setPlaceholder('http://<nas>:8321')
          .setValue(this.plugin.settings.workerUrl)
          .onChange(async (v) => {
            this.plugin.settings.workerUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('访问 token')
      .setDesc('服务启动时打印/LEXORA_TOKEN；局域网访问必填（配对可自动填写）。连接官方/托管 worker 时，这里直接填你的 Pro license key。')
      .addText((t) =>
        t.setValue(this.plugin.settings.workerToken).onChange(async (v) => {
          this.plugin.settings.workerToken = v.trim();
          await this.plugin.saveSettings();
        }),
      )
      .addButton((b) =>
        b.setButtonText('测试连接').onClick(async () => {
          const caps = await this.plugin.worker.capabilities();
          new Notice(caps
            ? `已连接 ${caps.name} · 转写:${caps.features.transcribe ? '✓' : '✗'} · TTS:${caps.features.tts ? '✓' : '✗'} · whisper ${caps.models?.whisper ?? '-'}`
            : '连接失败：检查地址 / token / 服务是否在跑');
        }),
      );
    new Setting(containerEl)
      .setName('配对')
      .setDesc('免抄 token：启动 worker 后 15 分钟内，输入地址和日志里打印的 6 位配对码即可自动完成配置（docker compose logs | grep 配对码）。')
      .addButton((b) =>
        b.setButtonText('配对…').setCta().onClick(() => {
          new WorkerPairModal(this.app, this.plugin, () => this.display()).open();
        }),
      );

    new Setting(containerEl)
      .setName('句子朗读引擎')
      .setDesc('Piper 在 NAS 本地合成、免费；OpenAI TTS 即 ChatGPT 的朗读（带语气、更拟真），按量计费约 $0.015/千字，密钥只存本机。单词真人读音不受此影响。')
      .addDropdown((d) => {
        d.addOption('worker', 'Piper（伴侣服务，免费）');
        d.addOption('openai', 'OpenAI TTS（ChatGPT 同款）');
        d.setValue(this.plugin.settings.ttsProvider);
        d.onChange(async (v) => {
          this.plugin.settings.ttsProvider = v as 'worker' | 'openai';
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName('OpenAI API Key')
      .setDesc('platform.openai.com → API keys。仅在引擎选 OpenAI 时使用。')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-…').setValue(this.plugin.settings.openaiKey);
        t.onChange(async (v) => {
          this.plugin.settings.openaiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });
    const oaiRow = new Setting(containerEl)
      .setName('OpenAI 音色')
      .setDesc('nova/shimmer 女声自然，onyx 男声沉稳，fable 英音叙事感；换音色后新合成生效（已缓存的句子不变）。');
    oaiRow.addDropdown((d) => {
      for (const v of ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']) {
        d.addOption(v, v);
      }
      d.setValue(this.plugin.settings.openaiVoice);
      d.onChange(async (v) => {
        this.plugin.settings.openaiVoice = v;
        await this.plugin.saveSettings();
      });
    });
    oaiRow.addButton((b) => b.setButtonText('试听').onClick(async () => {
      const buf = await fetchOpenaiTts(this.plugin, "Hello! I'm your reading voice. Let's learn English together.");
      if (!buf) { new Notice('试听失败：检查 API Key 与网络'); return; }
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      void audio.play();
    }));

    new Setting(containerEl)
      .setName('单词发音源')
      .setDesc('单词/短语的读音来源。词典真人读音最清晰（同旧套件的实现，在线获取并缓存到 vault）；句子朗读始终走伴侣服务 TTS。')
      .addDropdown((d) => {
        d.addOption('dict', '词典真人读音（推荐）');
        d.addOption('worker', '伴侣服务 TTS');
        d.addOption('system', '系统语音');
        d.setValue(this.plugin.settings.wordAudioSource);
        d.onChange(async (v) => {
          this.plugin.settings.wordAudioSource = v as 'dict' | 'worker' | 'system';
          await this.plugin.saveSettings();
        });
      });

    const voiceRow = new Setting(containerEl)
      .setName('TTS 音色')
      .setDesc('来自伴侣服务的 Piper 音色列表；换音色后新合成的发音生效（已缓存的不变）。');
    void this.plugin.worker.capabilities().then((caps) => {
      const voices = caps?.voices ?? [];
      voiceRow.addDropdown((d) => {
        d.addOption('', `服务默认（${caps?.models?.piper ?? 'auto'}）`);
        for (const v of voices) d.addOption(v, v);
        d.setValue(this.plugin.settings.ttsVoice);
        d.onChange(async (v) => {
          this.plugin.settings.ttsVoice = v;
          await this.plugin.saveSettings();
        });
      });
      if (!caps) voiceRow.setDesc('未连接伴侣服务，暂不可选（浏览器兑底音不受此项影响）。');
      voiceRow.addButton((b) =>
        b.setButtonText('试听').onClick(async () => {
          try {
            const buf = await this.plugin.worker.tts(
              'Learning English with Lexora feels natural and clear.',
              this.plugin.settings.ttsVoice,
            );
            const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
            const audio = new Audio(url);
            audio.onended = () => URL.revokeObjectURL(url);
            void audio.play();
          } catch (e) {
            new Notice(`试听失败：${(e as Error).message}`);
          }
        }),
      );
    });

    new Setting(containerEl).setName('欧路同步').setHeading();

    new Setting(containerEl)
      .setName('欧路开放 API token')
      .setDesc('my.eudic.net → 开放 API 获取；只用于把生词推送到欧路生词本。')
      .addText((t) =>
        t.setValue(this.plugin.settings.eudicToken).onChange(async (v) => {
          this.plugin.settings.eudicToken = v.trim();
          await this.plugin.saveSettings();
        }),
      )
      .addButton((b) =>
        b.setButtonText('拉取词本列表').onClick(async () => {
          try {
            const cats = await this.plugin.eudic.listCategories();
            if (cats.length === 0) { new Notice('欧路账号里没有生词本'); return; }
            this.plugin.settings.eudicCategoryId = this.plugin.settings.eudicCategoryId || cats[0].id;
            (this as unknown as { eudicCats?: typeof cats }).eudicCats = cats;
            await this.plugin.saveSettings();
            new Notice(`拉到 ${cats.length} 个生词本`);
            this.display();
          } catch (e) {
            new Notice(`拉取失败：${(e as Error).message}`);
          }
        }),
      );

    const cats = (this as unknown as { eudicCats?: Array<{ id: string; name: string }> }).eudicCats;
    const target = new Setting(containerEl)
      .setName('目标生词本')
      .setDesc(this.plugin.settings.eudicCategoryName
        ? `当前：${this.plugin.settings.eudicCategoryName}（欧路词本存在于欧路 App，不会出现在 Lexora 单词本里；这里只是选择推送目标）`
        : '点上方「拉取词本列表」后选择');
    if (cats?.length) {
      target.addDropdown((d) => {
        for (const c of cats) d.addOption(c.id, c.name);
        if (this.plugin.settings.eudicCategoryId) d.setValue(this.plugin.settings.eudicCategoryId);
        d.onChange(async (v) => {
          this.plugin.settings.eudicCategoryId = v;
          this.plugin.settings.eudicCategoryName = cats.find((c) => c.id === v)?.name ?? '';
          await this.plugin.saveSettings();
        });
        const cur = cats.find((c) => c.id === this.plugin.settings.eudicCategoryId);
        if (cur) {
          this.plugin.settings.eudicCategoryName = cur.name;
          void this.plugin.saveSettings();
        }
      });
    }
    new Setting(containerEl)
      .setName('从欧路导入词本到 Lexora')
      .setDesc('把欧路生词本拉进来变成本地词本（同名复用），词卡自动用词库补全，高亮/复习/例句全套可用。')
      .addButton((b) =>
        b.setButtonText('选择并导入').setCta().onClick(async () => {
          try {
            const cats = await this.plugin.eudic.listCategories();
            if (cats.length === 0) { new Notice('欧路账号里没有生词本'); return; }
            new EudicPickModal(this.app, cats, (cat) => void this.plugin.eudic.importCategory(cat)).open();
          } catch (e) {
            new Notice(`拉取失败：${(e as Error).message}`);
          }
        }),
      );

    new Setting(containerEl)
      .setName('收词时自动同步到欧路')
      .setDesc('新收录的词自动推送到上面的生词本，手机欧路里继续背。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.eudicAutoSync).onChange(async (v) => {
          this.plugin.settings.eudicAutoSync = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('更新与统计').setHeading();
    new Setting(containerEl)
      .setName('启动时检查更新')
      .setDesc('每天最多查询一次 GitHub Releases；发现新版本弹一次提示。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.updateCheckEnabled).onChange(async (v) => {
          this.plugin.settings.updateCheckEnabled = v;
          await this.plugin.saveSettings();
        }),
      )
      .addButton((b) =>
        b.setButtonText('立即检查').onClick(() => void checkForUpdate(this.plugin, true)),
      );
    new Setting(containerEl)
      .setName('匿名使用统计')
      .setDesc('每周最多一个匿名 ping：随机安装 ID、版本、平台、档位与粗粒度计数。不含任何笔记内容、vault 信息或密钥。' +
        (TELEMETRY_ENDPOINT ? '' : '（当前统计端点未启用，不会发送任何数据）'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.telemetryEnabled).onChange(async (v) => {
          this.plugin.settings.telemetryEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('导入').setHeading();

    new Setting(containerEl)
      .setName('known-words.txt 路径')
      .setDesc('一行一个词；命令「导入已掌握词表」会读取它。')
      .addText((t) =>
        t.setPlaceholder('50-Resources/Vocabulary/known-words.txt')
          .setValue(this.plugin.settings.knownWordsPath)
          .onChange(async (v) => {
            this.plugin.settings.knownWordsPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}


class EudicPickModal extends FuzzySuggestModal<{ id: string; name: string }> {
  constructor(
    app: App,
    private cats: Array<{ id: string; name: string }>,
    private onPick: (c: { id: string; name: string }) => void,
  ) {
    super(app);
    this.setPlaceholder('选择要导入的欧路生词本');
  }
  getItems() { return this.cats; }
  getItemText(c: { id: string; name: string }): string { return c.name; }
  onChooseItem(c: { id: string; name: string }): void { this.onPick(c); }
}


/** 配对弹窗：地址 + 6 位配对码 → POST /v1/pair → 自动写入地址与 token。 */
class WorkerPairModal extends Modal {
  constructor(app: App, private plugin: ElpPlugin, private onDone: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '配对 elp-worker' });
    let url = this.plugin.settings.workerUrl || 'http://';
    let code = '';
    new Setting(contentEl)
      .setName('服务地址')
      .addText((t) => {
        t.setPlaceholder('http://<nas>:8321').setValue(url).onChange((v) => (url = v.trim()));
        t.inputEl.style.width = '220px';
      });
    new Setting(contentEl)
      .setName('配对码')
      .setDesc('worker 启动日志里打印的 6 位数字')
      .addText((t) => t.setPlaceholder('123456').onChange((v) => (code = v.trim())));
    new Setting(contentEl).addButton((b) =>
      b.setButtonText('配对').setCta().onClick(async () => {
        const base = url.replace(/\/+$/, '');
        if (!/^https?:\/\//.test(base) || !/^\d{6}$/.test(code)) {
          new Notice('请填写完整地址（含 http://）和 6 位配对码');
          return;
        }
        try {
          const res = await requestUrl({
            url: `${base}/v1/pair`,
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ code }),
            throw: false,
          });
          if (res.status !== 200 || !res.json?.token) {
            const detail = res.json?.detail ?? `HTTP ${res.status}`;
            new Notice(`配对失败：${detail}`);
            return;
          }
          this.plugin.settings.workerUrl = base;
          this.plugin.settings.workerToken = String(res.json.token);
          await this.plugin.saveSettings();
          const caps = await this.plugin.worker.capabilities();
          new Notice(caps ? `配对成功：${caps.name} ✓` : '已保存 token，但能力检查未通过，请点「测试连接」排查');
          this.close();
          this.onDone();
        } catch (e) {
          new Notice(`配对失败：${(e as Error).message}`);
        }
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
