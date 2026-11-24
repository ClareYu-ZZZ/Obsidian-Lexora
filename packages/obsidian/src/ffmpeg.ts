/** 桌面端本地 ffmpeg/ffprobe 探测与执行（移动端一律返回 null/失败）。 */
import { Platform } from 'obsidian';

type Req = (m: string) => unknown;

function nodeRequire(): Req | null {
  if (!Platform.isDesktopApp) return null;
  return (window as Window & { require?: Req }).require ?? null;
}

const FF_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];

export function findFfmpeg(): string | null {
  const req = nodeRequire();
  if (!req) return null;
  const fs = req('fs') as typeof import('fs');
  for (const c of FF_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const { execFileSync } = req('child_process') as typeof import('child_process');
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return null;
  }
}

export function findFfprobe(): string | null {
  const ff = findFfmpeg();
  if (!ff) return null;
  const req = nodeRequire()!;
  const fs = req('fs') as typeof import('fs');
  const probe = ff === 'ffmpeg' ? 'ffprobe' : ff.replace(/ffmpeg$/, 'ffprobe');
  if (probe === 'ffprobe') {
    try {
      const { execFileSync } = req('child_process') as typeof import('child_process');
      execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
      return 'ffprobe';
    } catch {
      return null;
    }
  }
  return fs.existsSync(probe) ? probe : null;
}

export function runFf(bin: string, args: string[]): Promise<void> {
  const req = nodeRequire();
  if (!req) return Promise.reject(new Error('ffmpeg 仅桌面端可用'));
  const { execFile } = req('child_process') as typeof import('child_process');
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1 << 24 }, (err) => (err ? reject(err) : resolve()));
  });
}

/** 浏览器内核可直接解码的音频编码；其余（ac3/eac3/dts/truehd…）播放会静默无声。 */
const WEB_SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis']);

/** 返回首条音轨编码名（无 ffprobe/无音轨/探测失败返回 null）。 */
export async function probeAudioCodec(absPath: string): Promise<string | null> {
  const probe = findFfprobe();
  const req = nodeRequire();
  if (!probe || !req) return null;
  const { execFile } = req('child_process') as typeof import('child_process');
  return new Promise((resolve) => {
    execFile(
      probe,
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', absPath],
      { maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? null : (String(stdout).trim().split('\n')[0] || null)),
    );
  });
}

export function isWebSafeAudio(codec: string | null): boolean {
  return codec === null || WEB_SAFE_AUDIO.has(codec);
}
