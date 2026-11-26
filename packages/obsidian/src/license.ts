/**
 * Plugin-side licensing: Ed25519 verification (noble), trial bookkeeping,
 * and the single `ensurePro` gate every Pro feature calls.
 */
import { Notice } from 'obsidian';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import {
  computeLicenseState, hasPro, verifyLicenseKey,
  lessonQuotaLimit, normalizeLessonUsage,
  PRO_FEATURE_LABELS, TRIAL_DAYS,
  WORKER_TRIAL_TOTAL,
  type LicensePayload, type LicenseState, type ProFeature,
} from '@elp/core';
import type ElpPlugin from './main';

// noble v2 needs a sync sha512 wired once.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

/** Lexora release public key (Ed25519, hex). The private key never ships. */
export const LEXORA_PUBLIC_KEY_HEX = '47b76ac85ae108a5afd0e9f0cc31357fbdf93b571b1e6815316c474ec051df42';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 本机设备指纹：存 localStorage（按设备隔离，不随 vault 同步）。 */
export function deviceId(): string {
  const KEY = 'lexora-device-id';
  let id = window.localStorage.getItem(KEY);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('');
    window.localStorage.setItem(KEY, id);
  }
  return id;
}

export class LicenseManager {
  state: LicenseState = { tier: 'free' };
  private verified: LicensePayload | null = null;

  constructor(private plugin: ElpPlugin) {}

  /** Re-verify the stored key (if any) and recompute the tier. */
  async refresh(): Promise<LicenseState> {
    const { licenseKey, trialStartedAt } = this.plugin.settings;
    let keyError: string | undefined;
    this.verified = null;
    if (licenseKey?.trim()) {
      try {
        this.verified = await verifyLicenseKey(
          licenseKey,
          hexToBytes(LEXORA_PUBLIC_KEY_HEX),
          (msg, sig, pub) => ed.verify(sig, msg, pub),
        );
      } catch (e) {
        keyError = e instanceof Error ? e.message : String(e);
      }
    }
    this.state = computeLicenseState({
      verified: this.verified, keyError, trialStartedAt,
      trialDeviceOk: this.plugin.settings.trialDeviceId ? this.plugin.settings.trialDeviceId === deviceId() : true,
    });
    return this.state;
  }

  /** Recompute tier from the clock without re-verifying (cheap, call freely). */
  tick(): LicenseState {
    this.state = computeLicenseState({
      verified: this.verified,
      keyError: this.state.keyError,
      trialStartedAt: this.plugin.settings.trialStartedAt,
      trialDeviceOk: this.plugin.settings.trialDeviceId ? this.plugin.settings.trialDeviceId === deviceId() : true,
    });
    return this.state;
  }

  get pro(): boolean {
    return hasPro(this.tick());
  }

  /** 当前档位（worker-client 等轻量调用）。 */
  tickTier(): 'free' | 'trial' | 'pro' {
    return this.tick().tier;
  }

  /**
   * The one gate. Returns true when the feature may run. On first Pro use
   * with no trial yet, starts the 14-day trial. When locked, shows why.
   */
  ensurePro(feature: ProFeature): boolean {
    const st = this.tick();
    if (hasPro(st)) return true;
    if (!st.trialExpired && this.plugin.settings.trialStartedAt === undefined) {
      this.plugin.settings.trialStartedAt = Date.now();
      this.plugin.settings.trialDeviceId = deviceId();
      void this.plugin.saveSettings();
      this.tick();
      new Notice(`Lexora Pro 试用已开始：${TRIAL_DAYS} 天内可使用全部功能（elp-worker 转录限 ${WORKER_TRIAL_TOTAL} 个，本设备专享）。\n（${PRO_FEATURE_LABELS[feature]}）`, 8000);
      return true;
    }
    new Notice(`「${PRO_FEATURE_LABELS[feature]}」是 Lexora Pro 功能。\n试用已结束——请在设置中输入 license key 解锁。`, 8000);
    return false;
  }

  /** Monthly lesson-generation quota: gate at entry, count at success. */
  checkLessonQuota(): boolean {
    const usage = normalizeLessonUsage(this.plugin.settings.lessonUsage);
    const limit = lessonQuotaLimit(this.tick());
    if (usage.used >= limit) {
      const upsell = this.pro ? '' : '升级 Lexora Pro：每月 20 个教程 + 10 个 worker 原声转写。';
      new Notice(`本月教程生成额度已用完（${usage.used}/${limit}）。额度每月 1 日重置。${upsell}`, 8000);
      return false;
    }
    return true;
  }

  /** Call once per successfully generated lesson. */
  async consumeLessonQuota(): Promise<void> {
    const usage = normalizeLessonUsage(this.plugin.settings.lessonUsage);
    usage.used += 1;
    this.plugin.settings.lessonUsage = usage;
    await this.plugin.saveSettings();
  }

  quotaText(): string {
    const usage = normalizeLessonUsage(this.plugin.settings.lessonUsage);
    return `本月教程生成：${usage.used}/${lessonQuotaLimit(this.tick())}`;
  }

  /** One-line status for the settings page. */
  statusText(): string {
    const st = this.tick();
    if (st.tier === 'pro') {
      return `Pro 已激活：${st.payload?.email ?? ''}，有效期至 ${new Date(st.payload!.exp).toLocaleDateString()}`;
    }
    if (st.tier === 'trial') return `Pro 试用中：剩余 ${st.trialDaysLeft} 天`;
    if (st.keyError) return `Key 无效：${st.keyError}`;
    if (st.trialDeviceBlocked) return '免费版（试用已在另一台设备使用；免费档限 1 台设备）';
    if (st.trialExpired) return '免费版（试用已结束）';
    return `免费版（首次使用 Pro 功能时自动开始 ${TRIAL_DAYS} 天试用）`;
  }
}
