/**
 * Lexora licensing — offline signed license keys + trial state machine.
 *
 * Key format (ASCII, safe to copy-paste):
 *   LEXORA1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
 * The signature covers the raw payload JSON bytes. The private key never
 * ships; hosts embed only the public key and an Ed25519 verify function.
 *
 * Trial model (honest-user, no server): the host stores `trialStartedAt`
 * the first time a Pro feature is used; the trial unlocks everything for
 * TRIAL_DAYS, then the plugin falls back to the free tier. Deleting local
 * data resets it — acceptable by design for this product stage.
 */

export const LICENSE_PREFIX = 'LEXORA1';
export const TRIAL_DAYS = 3;

export interface LicensePayload {
  v: 1;
  plan: 'pro';
  /** Licensee e-mail (shown in settings, ties the key to a purchase). */
  email: string;
  /** Issue time, unix ms. */
  iat: number;
  /** Expiry, unix ms. Pro is subscription-only: every key MUST carry one. */
  exp: number;
}

export type LicenseTier = 'free' | 'trial' | 'pro';

export interface LicenseState {
  tier: LicenseTier;
  /** Verified payload when tier === 'pro'. */
  payload?: LicensePayload;
  /** Days left, rounded up, when tier === 'trial'. */
  trialDaysLeft?: number;
  /** True when a trial was used up (drives "trial over" messaging). */
  trialExpired?: boolean;
  /** Set when a key was present but rejected (bad format/signature/expired). */
  keyError?: string;
  /** True when a trial exists but was started on a different device (free tier enforced). */
  trialDeviceBlocked?: boolean;
}

/** Ed25519 verify, injected by the host (plugin bundles an implementation). */
export type VerifyFn = (
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) => boolean | Promise<boolean>;

/** Pro feature gates. Everything not listed here is free forever. */
export type ProFeature = 'worker-advanced' | 'review-advanced';

export const PRO_FEATURE_LABELS: Record<ProFeature, string> = {
  'worker-advanced': 'Worker 高级功能（转写 / 视频切片 / YouTube 下载）',
  'review-advanced': '高级复习模式（听音辨意 / 听写 / 例句拼写）',
};

/** Review modes behind the Pro gate; the other four stay free. */
export const PRO_REVIEW_MODES = ['listening', 'listening-spell', 'cloze-spell'] as const;

export function isProReviewMode(mode: string): boolean {
  return (PRO_REVIEW_MODES as readonly string[]).includes(mode);
}

/* ---------------- base64url (pure, host-agnostic) ---------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_REV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_REV[B64[i]] = i;

export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64[c & 63];
  }
  return out;
}

export function b64urlDecode(s: string): Uint8Array {
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = B64_REV[ch];
    if (v === undefined) throw new Error('bad base64url');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function utf8(s: string): Uint8Array {
  // TextEncoder exists in every host Lexora targets (Electron, mobile webview, node).
  return new TextEncoder().encode(s);
}

/* ---------------- key parsing & verification ---------------- */

export function parseLicenseKey(key: string): { payload: LicensePayload; message: Uint8Array; signature: Uint8Array } {
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) throw new Error('这不是 Lexora license key');
  const message = b64urlDecode(parts[1]);
  const signature = b64urlDecode(parts[2]);
  let payload: LicensePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(message));
  } catch {
    throw new Error('key 内容损坏');
  }
  if (payload.v !== 1 || payload.plan !== 'pro' || typeof payload.email !== 'string') {
    throw new Error('key 字段不完整');
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('key 缺少有效期（Lexora Pro 为订阅制）');
  }
  return { payload, message, signature };
}

export async function verifyLicenseKey(
  key: string,
  publicKey: Uint8Array,
  verify: VerifyFn,
  now: number = Date.now(),
): Promise<LicensePayload> {
  const { payload, message, signature } = parseLicenseKey(key);
  const ok = await verify(message, signature, publicKey);
  if (!ok) throw new Error('key 签名无效');
  if (now > payload.exp) throw new Error('key 已过期');
  return payload;
}

/* ---------------- state machine ---------------- */

export interface LicenseInputs {
  /** Payload of an already-verified key, null when no/invalid key. */
  verified: LicensePayload | null;
  /** Error message when a key was present but failed verification. */
  keyError?: string;
  /** Unix ms when the trial started; undefined = never started. */
  trialStartedAt?: number;
  now?: number;
  trialDays?: number;
  /** False when the stored trial was started on another device. */
  trialDeviceOk?: boolean;
}

export function computeLicenseState(inp: LicenseInputs): LicenseState {
  const now = inp.now ?? Date.now();
  if (inp.verified) return { tier: 'pro', payload: inp.verified };
  const base: Pick<LicenseState, 'keyError'> = inp.keyError ? { keyError: inp.keyError } : {};
  if (inp.trialStartedAt !== undefined) {
    // 试用绑定首台设备：换设备视为试用不可用（免费版 1 台设备）
    if (inp.trialDeviceOk === false) {
      return { ...base, tier: 'free', trialExpired: true, trialDeviceBlocked: true };
    }
    const days = inp.trialDays ?? TRIAL_DAYS;
    const msLeft = inp.trialStartedAt + days * 86400_000 - now;
    if (msLeft > 0) {
      return { ...base, tier: 'trial', trialDaysLeft: Math.ceil(msLeft / 86400_000) };
    }
    return { ...base, tier: 'free', trialExpired: true };
  }
  return { ...base, tier: 'free' };
}

/** A tier that unlocks Pro features right now. */
export function hasPro(state: LicenseState): boolean {
  return state.tier === 'pro' || state.tier === 'trial';
}

/** Build the exact bytes licgen signs — kept here so tool and app can't drift. */
export function encodeLicense(payload: LicensePayload, signature: Uint8Array): string {
  return `${LICENSE_PREFIX}.${b64urlEncode(utf8(JSON.stringify(payload)))}.${b64urlEncode(signature)}`;
}

/* ---------------- monthly lesson-generation quota ---------------- */

/** 各档位每自然月可生成的教程数（非 worker 转录：字幕/文本等本地管线）。 */
export const LESSON_QUOTA: Record<LicenseTier, number> = { free: 10, trial: 20, pro: 20 };

export function lessonQuotaLimit(state: LicenseState): number {
  return LESSON_QUOTA[state.tier];
}

/** elp-worker 转录配额：试用期累计 3 个；Pro 每自然月 10 个（worker 侧强制执行）。 */
export const WORKER_TRIAL_TOTAL = 3;
export const WORKER_PRO_MONTHLY = 10;

/** 设备数上限（防 key 外借）：免费/试用 1 台，Pro 3 台。 */
export const DEVICE_LIMIT: Record<'free' | 'pro', number> = { free: 1, pro: 3 };

/** Pro 定价（人民币）：管理台签发页默认值，可在签发时改价。 */
export const PRICING = [
  { plan: 'monthly', label: '按月', months: 1, price: 25 },
  { plan: 'quarterly', label: '按季（约 9 折）', months: 3, price: 68 },
  { plan: 'yearly', label: '按年（约 66 折）', months: 12, price: 198 },
] as const;

export interface LessonUsage {
  /** Local calendar month, e.g. "2026-11". */
  month: string;
  used: number;
}

export function monthKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Roll the counter over on month change; tolerate missing/old data. */
export function normalizeLessonUsage(u: LessonUsage | undefined, now: Date = new Date()): LessonUsage {
  const month = monthKey(now);
  return u && u.month === month ? u : { month, used: 0 };
}
