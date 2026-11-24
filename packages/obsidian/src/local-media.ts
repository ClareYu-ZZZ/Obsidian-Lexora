import { Modal, Notice, Platform, Setting, TFile } from 'obsidian';
import type ElpPlugin from './main';
import { generateFromMedia } from './generate';
import { SubtitlePickModal } from './subtitle-modal';

const MEDIA_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'mp3', 'm4a', 'wav', 'ogg', 'flac']);

const MEDIA_ACCEPT = [...MEDIA_EXT].map((e) => `.${e}`).join(',');

/** 命令入口：系统文件选择器挑任意位置的音视频 → 导入 vault → 生成教程。 */
export function pickLocalMedia(plugin: ElpPlugin): void {
  const input = createEl('input', { type: 'file', attr: { accept: MEDIA_ACCEPT } });
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void importPickedFile(plugin, f);
  };
  input.click();
}

/**
 * 读取系统选择器给的文件。Chromium 的 blob 读取在 macOS 受保护目录（桌面/文稿/
 * 下载等）上常抛 NotReadableError——桌面端自动降级为 Node fs 按绝对路径读。
 */
function pickedFilePath(picked: File): string | undefined {
  // 旧版 Electron 有 File.path；新版（Electron 32+，即较新的 Obsidian）已移除，
  // 要走官方的 webUtils.getPathForFile。
  const direct = (picked as File & { path?: string }).path;
  if (direct) return direct;
  const req = (window as Window & { require?: (m: string) => unknown }).require;
  if (!Platform.isDesktopApp || !req) return undefined;
  try {
    const electron = req('electron') as { webUtils?: { getPathForFile?: (f: File) => string } };
    return electron.webUtils?.getPathForFile?.(picked);
  } catch {
    return undefined;
  }
}

async function readPickedFile(picked: File): Promise<ArrayBuffer> {
  try {
    return await picked.arrayBuffer();
  } catch (e) {
    const abs = pickedFilePath(picked);
    const req = (window as Window & { require?: (m: string) => unknown }).require;
    if (abs && Platform.isDesktopApp && req) {
      const fs = req('fs/promises') as { readFile: (p: string) => Promise<Uint8Array> };
      const buf = await fs.readFile(abs);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }
    throw e;
  }
}

function explainReadError(e: Error): string {
  if (/could not be read|NotReadable|EPERM|operation not permitted/i.test(e.message)) {
    return '读取被系统拦截（macOS 文件权限）。修复：系统设置 → 隐私与安全性 → 文件与文件夹（或完全磁盘访问权限）→ 允许 Obsidian；或把文件移出桌面/文稿/下载目录后重试。';
  }
  return e.message;
}

/** 把系统选择器拿到的文件接进原流程：vault 内文件直接用，vault 外导入副本。 */
async function importPickedFile(plugin: ElpPlugin, picked: File): Promise<void> {
  const ext = (picked.name.split('.').pop() ?? '').toLowerCase();
  if (!MEDIA_EXT.has(ext)) {
    new Notice(`不支持的格式：.${ext}`);
    return;
  }
  // 桌面端：若选中的就是 vault 内文件，不复制，直接用原文件
  const abs = pickedFilePath(picked);
  const adapter = plugin.app.vault.adapter as { getBasePath?: () => string };
  const base = adapter.getBasePath?.();
  if (abs && base && abs.startsWith(base)) {
    const rel = abs.slice(base.length).replace(/\\/g, '/').replace(/^\/+/, '');
    const existing = plugin.app.vault.getAbstractFileByPath(rel);
    if (existing instanceof TFile) {
      await onMediaPicked(plugin, existing);
      return;
    }
  }
  // vault 外：导入到 <教程目录>/_imports/
  const dir = `${plugin.settings.lessonsFolder}/_imports`;
  if (!plugin.app.vault.getAbstractFileByPath(dir)) {
    await plugin.app.vault.createFolder(dir).catch(() => undefined);
  }
  let dest = `${dir}/${picked.name}`;
  for (let i = 1; plugin.app.vault.getAbstractFileByPath(dest); i++) {
    dest = `${dir}/${picked.name.replace(/(\.[^.]+)$/, `-${i}$1`)}`;
  }
  const notice = new Notice(`导入 ${picked.name}…`, 0);
  try {
    let file: TFile | null = null;
    const abs = pickedFilePath(picked);
    if (abs && Platform.isDesktopApp) {
      // 桌面端：Node 流式复制，内存占用恒定，不受 2GiB 限制
      file = await streamImport(plugin, abs, dest, picked.size, notice);
    } else {
      if (picked.size > 1.8 * 1024 ** 3) {
        throw new Error('文件超过 1.8GB，移动端无法导入，请在电脑上操作');
      }
      file = await plugin.app.vault.createBinary(dest, await readPickedFile(picked)) as TFile;
    }
    notice.hide();
    if (file) await onMediaPicked(plugin, file);
  } catch (e) {
    notice.hide();
    new Notice(`导入失败：${explainReadError(e as Error)}`, 12000);
  }
}

/** Node 流式复制进 vault，并等 vault 索引到新文件。 */
async function streamImport(
  plugin: ElpPlugin,
  srcAbs: string,
  destRel: string,
  totalBytes: number,
  notice: Notice,
): Promise<TFile> {
  const req = (window as Window & { require?: (m: string) => unknown }).require!;
  const fs = req('fs') as typeof import('fs');
  const pathMod = req('path') as typeof import('path');
  const adapter = plugin.app.vault.adapter as { getBasePath?: () => string };
  const base = adapter.getBasePath?.();
  if (!base) throw new Error('无法定位 vault 目录');
  const destAbs = pathMod.join(base, ...destRel.split('/'));
  await fs.promises.mkdir(pathMod.dirname(destAbs), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(srcAbs);
    const ws = fs.createWriteStream(destAbs);
    let copied = 0;
    rs.on('data', (chunk: string | Buffer) => {
      copied += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
      if (totalBytes > 0) {
        notice.setMessage(`导入中 ${(copied / totalBytes * 100).toFixed(0)}%（${(copied / 1048576).toFixed(0)}MB）…`);
      }
    });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => resolve());
    rs.pipe(ws);
  });
  // vault 文件监听通常 1 秒内索引到；轮询拿 TFile
  for (let i = 0; i < 50; i++) {
    const f = plugin.app.vault.getAbstractFileByPath(destRel);
    if (f instanceof TFile) return f;
    await new Promise((r) => window.setTimeout(r, 200));
  }
  throw new Error('导入完成但 vault 未索引到文件，请重启 Obsidian 后在 _imports 目录找到它');
}

function findSidecarSubtitle(plugin: ElpPlugin, media: TFile): TFile | null {
  const folder = media.parent?.path ?? '';
  const prefix = media.basename.toLowerCase();
  const subs = plugin.app.vault.getFiles().filter((f) =>
    (f.extension === 'vtt' || f.extension === 'srt') &&
    (f.parent?.path ?? '') === folder &&
    f.basename.toLowerCase().startsWith(prefix),
  );
  return subs[0] ?? null;
}

async function onMediaPicked(plugin: ElpPlugin, media: TFile): Promise<void> {
  const sidecar = findSidecarSubtitle(plugin, media);
  if (sidecar) {
    await generateFromMedia(plugin, {
      title: media.basename,
      media: { kind: 'local', path: media.path },
      subtitleFile: sidecar,
    });
    return;
  }
  new SubtitleSourceModal(plugin, media).open();
}

/** 无同名字幕时：选字幕文件，或走 elp-worker 转写。 */
class SubtitleSourceModal extends Modal {
  constructor(private plugin: ElpPlugin, private media: TFile) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `${this.media.name} 没有同名字幕` });

    new Setting(contentEl)
      .setName('选择字幕文件（.vtt / .srt）')
      .addButton((b) => b.setButtonText('从文件系统选…').setCta().onClick(() => {
        const input = createEl('input', { type: 'file', attr: { accept: '.vtt,.srt' } });
        input.onchange = () => {
          const f = input.files?.[0];
          if (!f) return;
          this.close();
          void (async () => {
            const text = new TextDecoder().decode(await readPickedFile(f));
            await generateFromMedia(this.plugin, {
              title: this.media.basename,
              media: { kind: 'local', path: this.media.path },
              subtitleText: text,
            });
          })();
        };
        input.click();
      }))
      .addButton((b) => b.setButtonText('从 vault 选').onClick(() => {
        this.close();
        new SubtitlePickModal(this.app, this.plugin, (sub) => {
          void generateFromMedia(this.plugin, {
            title: this.media.basename,
            media: { kind: 'local', path: this.media.path },
            subtitleFile: sub,
          });
        }).open();
      }));

    const caps = await this.plugin.worker.capabilities();
    const transcribeRow = new Setting(contentEl)
      .setName('用本地服务转写（faster-whisper）')
      .setDesc(caps?.features.transcribe
        ? `已连接 ${caps.name}（whisper ${caps.models?.whisper ?? ''}）`
        : '未连接伴侣服务：设置 → Lexora → 伴侣服务 填好地址后可用');
    transcribeRow.addButton((b) => {
      b.setButtonText('开始转写').setCta().onClick(() => void this.transcribe());
      if (!caps?.features.transcribe) b.setDisabled(true);
    });
  }

  private async transcribe(): Promise<void> {
    if (!this.plugin.license.ensurePro('worker-advanced')) return;
    this.close();
    const notice = new Notice('上传媒体并转写中…', 0);
    try {
      const vtt = await this.plugin.worker.transcribe(this.media, (status, progress) => {
        notice.setMessage(status === 'running'
          ? `转写中 ${(progress * 100).toFixed(0)}%…`
          : '排队中…');
      });
      const subPath = `${this.media.parent?.path ?? ''}/${this.media.basename}.en.vtt`.replace(/^\//, '');
      const existing = this.plugin.app.vault.getAbstractFileByPath(subPath);
      const subFile = existing instanceof TFile
        ? (await this.plugin.app.vault.modify(existing, vtt), existing)
        : await this.plugin.app.vault.create(subPath, vtt);
      notice.hide();
      new Notice(`字幕已保存：${subPath}`);
      await generateFromMedia(this.plugin, {
        title: this.media.basename,
        media: { kind: 'local', path: this.media.path },
        subtitleFile: subFile,
      });
    } catch (e) {
      notice.hide();
      new Notice(`转写失败：${(e as Error).message}`);
    }
  }

  onClose(): void { this.contentEl.empty(); }
}
