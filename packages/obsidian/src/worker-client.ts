import { TFile, requestUrl } from 'obsidian';
import type ElpPlugin from './main';
import { deviceId } from './license';

/** 上传源：vault 文件，或预处理后的内存字节（如大视频抽出的音轨）。 */
export type UploadSource = TFile | { name: string; bytes: ArrayBuffer };

export interface WorkerCapabilities {
  apiVersion: string;
  name: string;
  features: { transcribe: boolean; tts: boolean; clip: boolean; subtitle?: boolean; ytaudio?: boolean };
  models?: Record<string, string>;
  voices?: string[];
  fake?: boolean;
}

/** elp-worker（NAS/本机自托管）的 REST 客户端。 */
export class WorkerClient {
  constructor(private plugin: ElpPlugin) {}

  get configured(): boolean {
    return !!this.plugin.settings.workerUrl;
  }

  private base(): string {
    return this.plugin.settings.workerUrl.replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'x-lexora-device': deviceId() };
    const token = this.plugin.settings.workerToken;
    if (token) h.authorization = `Bearer ${token}`;
    // 试用期无 key：带试用设备头，worker 侧按设备累计 3 次转录配额
    else if (this.plugin.license.tickTier() === 'trial') h['x-lexora-trial-device'] = deviceId();
    return h;
  }

  async capabilities(): Promise<WorkerCapabilities | null> {
    if (!this.configured) return null;
    try {
      const res = await requestUrl({
        url: `${this.base()}/v1/capabilities`,
        headers: this.headers(),
        throw: false,
      });
      if (res.status !== 200) return null;
      return res.json as WorkerCapabilities;
    } catch {
      return null;
    }
  }

  /** YouTube 媒体 → 字节（worker 上 yt-dlp 下载，异步任务）。video=true 取 720p mp4。 */
  async ytMedia(
    videoId: string,
    video: boolean,
    onProgress?: (status: string, progress: number) => void,
  ): Promise<ArrayBuffer> {
    const res = await requestUrl({
      url: `${this.base()}/v1/ytaudio`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ video_id: videoId, video }),
      headers: this.headers(),
    });
    const jobId = (res.json as { job_id: string }).job_id;
    await this.poll(jobId, onProgress);
    const result = await requestUrl({
      url: `${this.base()}/v1/jobs/${jobId}/result`,
      headers: this.headers(),
    });
    return result.arrayBuffer;
  }

  /** YouTube 字幕（worker 上 yt-dlp 只拉字幕不下视频）。失败返回 null。 */
  async subtitle(videoId: string): Promise<string | null> {
    try {
      const res = await requestUrl({
        url: `${this.base()}/v1/subtitle`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ video_id: videoId }),
        headers: this.headers(),
        throw: false,
      });
      if (res.status >= 400) return null;
      const vtt = (res.json as { vtt?: string }).vtt;
      return vtt && vtt.includes('WEBVTT') ? vtt : null;
    } catch {
      return null;
    }
  }

  /** 句子/单词 → wav（Piper）。speed>1 更慢（旧版 worker 忽略该字段）。 */
  async tts(text: string, voice?: string, speed?: number): Promise<ArrayBuffer> {
    const res = await requestUrl({
      url: `${this.base()}/v1/tts`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ text, voice: voice || undefined, speed: speed && speed !== 1 ? speed : undefined }),
      headers: this.headers(),
    });
    return res.arrayBuffer;
  }

  /** 上传媒体 + 切片清单 → zip(mp3) 字节。 */
  async clipJob(
    file: TFile,
    segments: Array<{ name: string; start: number; end: number }>,
    onProgress?: (status: string, progress: number) => void,
  ): Promise<ArrayBuffer> {
    const jobId = await this.createJob(file, 'clip', { segments });
    await this.poll(jobId, onProgress);
    const result = await requestUrl({
      url: `${this.base()}/v1/jobs/${jobId}/result`,
      headers: this.headers(),
    });
    return result.arrayBuffer;
  }

  /** 上传媒体 → 轮询 → 返回 VTT 文本。 */
  async transcribe(
    file: UploadSource,
    onProgress?: (status: string, progress: number) => void,
  ): Promise<string> {
    const jobId = await this.createJob(file, 'transcribe', { language: 'en' });
    await this.poll(jobId, onProgress);
    const result = await requestUrl({
      url: `${this.base()}/v1/jobs/${jobId}/result`,
      headers: this.headers(),
    });
    return result.text;
  }

  private async createJob(file: UploadSource, type: string, options: unknown): Promise<string> {
    const bytes = file instanceof TFile ? await this.plugin.app.vault.readBinary(file) : file.bytes;
    const boundary = `----lexora${Date.now().toString(36)}`;
    const enc = new TextEncoder();
    const part = (name: string, value: string) =>
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const fileHead = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    );
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const chunks = [
      part('type', type),
      part('options', JSON.stringify(options ?? {})),
      fileHead,
      new Uint8Array(bytes),
      tail,
    ];
    const body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) { body.set(c, off); off += c.byteLength; }
    const created = await requestUrl({
      url: `${this.base()}/v1/jobs`,
      method: 'POST',
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: body.buffer as ArrayBuffer,
      headers: this.headers(),
    });
    return (created.json as { id: string }).id;
  }

  private async poll(
    jobId: string,
    onProgress?: (status: string, progress: number) => void,
  ): Promise<void> {
    for (;;) {
      await new Promise((r) => window.setTimeout(r, 1500));
      const st = await requestUrl({
        url: `${this.base()}/v1/jobs/${jobId}`,
        headers: this.headers(),
      });
      const job = st.json as { status: string; progress: number; error?: string };
      onProgress?.(job.status, job.progress);
      if (job.status === 'done') return;
      if (job.status === 'failed') throw new Error(job.error ?? '任务失败');
    }
  }
}
