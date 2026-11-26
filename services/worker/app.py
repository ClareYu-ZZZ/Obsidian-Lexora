"""
elp-worker — Lexora 的本地伴侣服务（自托管，开源）。

承担插件做不了的重活：faster-whisper 转写（无字幕媒体 → VTT）。
部署参考形态：NAS 上 Docker 常驻，局域网暴露端口。

安全模型：
- loopback 请求免鉴权；任何非 loopback 请求强制 Bearer token。
- token 来自环境变量 LEXORA_TOKEN；未设置则启动时生成并打印一次。
- 公网暴露请走反向代理 TLS 或 Tailscale/WireGuard。

测试模式：LEXORA_FAKE=1 时转写返回固定 VTT（CI / 无模型环境用）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import re
import shutil
import tempfile
import threading
from datetime import datetime, timezone
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

API_VERSION = "1.5"
FAKE = os.environ.get("LEXORA_FAKE") == "1"
WHISPER_MODEL = os.environ.get("LEXORA_WHISPER_MODEL", "small")
PIPER_VOICE = os.environ.get("LEXORA_PIPER_VOICE", "en_US-ryan-high")
PIPER_DIR = Path(os.environ.get("LEXORA_PIPER_DIR", "/voices"))
WHISPER_COMPUTE = os.environ.get("LEXORA_WHISPER_COMPUTE", "int8")
WHISPER_THREADS = int(os.environ.get("LEXORA_WHISPER_THREADS", "4"))
# 同时运行的转写数上限（小机型并发只会互相拖慢 + 内存吃紧；排队的任务显示 queued）
MAX_TRANSCRIBE = int(os.environ.get("LEXORA_MAX_TRANSCRIBE", "1"))
_TRANSCRIBE_SEM = threading.Semaphore(MAX_TRANSCRIBE)
TOKEN = os.environ.get("LEXORA_TOKEN") or secrets.token_urlsafe(24)
if not os.environ.get("LEXORA_TOKEN"):
    print(f"[elp-worker] generated token (set LEXORA_TOKEN to pin it): {TOKEN}", flush=True)

# 托管/共享模式：直接验 Lexora Pro license key（与插件同一把 Ed25519 公钥，离线验签）。
# LEXORA_ACCEPT_LICENSE_KEYS=1 开启；持有效 key 的用户可用转写/切片/TTS（按日限流），
# YouTube 端点始终仅站长可用（yt-dlp + cookies 属个人资产，也是商用红线）。
# 一本账：key 到期/吊销 → 功能与算力同时失效。
ACCEPT_LICENSE_KEYS = os.environ.get("LEXORA_ACCEPT_LICENSE_KEYS", "0") == "1"
LICENSE_PUBKEY_HEX = os.environ.get(
    "LEXORA_LICENSE_PUBKEY",
    "47b76ac85ae108a5afd0e9f0cc31357fbdf93b571b1e6815316c474ec051df42",
)
REVOKED_EMAILS = {e.strip().lower() for e in os.environ.get("LEXORA_REVOKED", "").split(",") if e.strip()}
LICENSED_DAILY_JOBS = int(os.environ.get("LEXORA_LICENSED_DAILY_JOBS", "10"))
LICENSED_DAILY_TTS = int(os.environ.get("LEXORA_LICENSED_DAILY_TTS", "300"))
if ACCEPT_LICENSE_KEYS:
    print("[elp-worker] 托管模式：接受 Lexora Pro license key 鉴权", flush=True)
_USE: dict = {}
_USE_LOCK = threading.Lock()


def _quota_take(identity: str, kind: str, limit: int) -> None:
    day = time.strftime("%Y-%m-%d", time.gmtime())
    with _USE_LOCK:
        rec = _USE.setdefault(identity, {})
        if rec.get("day") != day:
            rec.clear()
            rec["day"] = day
        n = rec.get(kind, 0)
        if n >= limit:
            raise HTTPException(status_code=429, detail=f"今日{kind}配额已用完（{limit}/天），明天再来")
        rec[kind] = n + 1


def _verify_license_key(key: str) -> str | None:
    """验 Pro key：签名、plan、有效期、吊销名单。通过返回 email，否则 None。"""
    try:
        prefix, p64, s64 = key.split(".")
        if prefix != "LEXORA1":
            return None
        pad = lambda x: x + "=" * (-len(x) % 4)  # noqa: E731
        msg = base64.urlsafe_b64decode(pad(p64))
        sig = base64.urlsafe_b64decode(pad(s64))
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(LICENSE_PUBKEY_HEX)).verify(sig, msg)
        payload = json.loads(msg)
        if payload.get("v") != 1 or payload.get("plan") != "pro":
            return None
        exp = payload.get("exp")
        if not isinstance(exp, (int, float)) or time.time() * 1000 > exp:
            return None
        email = str(payload.get("email", "")).strip().lower()
        if not email or email in REVOKED_EMAILS:
            return None
        return email
    except Exception:  # noqa: BLE001 — 任何解析/验签失败都视为无效
        return None

# 配对：启动后一段时间内，持 6 位配对码可换取 token（替代手抄 token）。
# 窗口过后端点关闭；重启容器即获得新配对码。LEXORA_PAIRING_WINDOW=0 可禁用。
PAIR_WINDOW = int(os.environ.get("LEXORA_PAIRING_WINDOW", "900"))
PAIR_CODE = f"{secrets.randbelow(1_000_000):06d}"
PAIR_STARTED = time.time()
PAIR_ATTEMPTS = 0
if PAIR_WINDOW > 0:
    print(
        f"[elp-worker] 配对码: {PAIR_CODE}（{PAIR_WINDOW // 60} 分钟内有效）—— "
        f"在 Lexora 设置 → 伴侣服务 → 配对 中输入地址和此码即可自动完成配置。",
        flush=True,
    )

WORK_DIR = Path(os.environ.get("LEXORA_WORK_DIR", tempfile.gettempdir())) / "elp-worker"
WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="elp-worker", version=API_VERSION)


# ---------------------------------------------------------------- auth

def require_auth(request: Request) -> str:
    """鉴权并返回角色：admin（站长/本机）或访客自己的 token。"""
    host = request.client.host if request.client else ""
    if host in ("127.0.0.1", "::1", "localhost"):
        return "admin"
    header = request.headers.get("authorization", "")
    if header == f"Bearer {TOKEN}":
        return "admin"
    bearer = header.removeprefix("Bearer ").strip()
    if ACCEPT_LICENSE_KEYS and bearer.startswith("LEXORA1."):
        email = _verify_license_key(bearer)
        if email:
            return f"pro:{email}"
        raise HTTPException(status_code=401, detail="license key 无效或已过期")
    raise HTTPException(status_code=401, detail="missing or invalid bearer token")


@app.post("/v1/pair")
def pair(body: dict) -> JSONResponse:
    """用配对码换 token。无鉴权，但受时间窗与尝试次数限制。"""
    global PAIR_ATTEMPTS
    if PAIR_WINDOW <= 0 or time.time() - PAIR_STARTED > PAIR_WINDOW:
        raise HTTPException(status_code=403, detail="配对窗口已关闭，重启 elp-worker 获取新配对码")
    if PAIR_ATTEMPTS >= 5:
        raise HTTPException(status_code=429, detail="尝试次数过多，重启 elp-worker 重试")
    if str(body.get("code", "")).strip() != PAIR_CODE:
        PAIR_ATTEMPTS += 1
        raise HTTPException(status_code=401, detail="配对码不正确")
    return JSONResponse({"token": TOKEN, "apiVersion": API_VERSION})


# ---------------------------------------------------------------- jobs

@dataclass
class Job:
    id: str
    type: str
    status: str = "queued"            # queued | running | done | failed
    progress: float = 0.0
    error: Optional[str] = None
    result_path: Optional[Path] = None
    created: float = field(default_factory=time.time)
    caller: str = "admin"


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()

# ---------------------------------------------------------------- 运维指标
# stdlib-only：sqlite 持久化事件（放 ~/.cache 卷里，重启不丢）+ 内存系统采样环。
import sqlite3
from collections import deque

_cache_dir = Path.home() / ".cache" / "elp-worker"
try:
    _cache_dir.mkdir(parents=True, exist_ok=True)
    METRICS_DB = Path(os.environ.get("LEXORA_METRICS_DB", _cache_dir / "metrics.db"))
except Exception:
    METRICS_DB = WORK_DIR / "metrics.db"
_mx_conn = sqlite3.connect(METRICS_DB, check_same_thread=False)
_mx_conn.execute(
    "CREATE TABLE IF NOT EXISTS events (ts REAL, kind TEXT, caller TEXT, duration_ms INTEGER, ok INTEGER, detail TEXT)"
)
_mx_conn.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)")
_mx_conn.commit()
_mx_lock = threading.Lock()
STARTED_AT = time.time()
ISSUED_FILE = Path(os.environ.get("LEXORA_ISSUED_FILE", "/data/issued.jsonl"))


def _record(kind: str, caller: str, t0: float, ok: bool, detail: str = "") -> None:
    try:
        with _mx_lock:
            _mx_conn.execute(
                "INSERT INTO events VALUES (?,?,?,?,?,?)",
                (time.time(), kind, caller, int((time.time() - t0) * 1000), 1 if ok else 0, detail[:200]),
            )
            _mx_conn.commit()
    except Exception:
        pass


_SYS_SAMPLES: deque = deque(maxlen=2880)  # 24h @ 30s


def _read_cpu() -> tuple[int, int]:
    parts = Path("/proc/stat").read_text().splitlines()[0].split()[1:]
    vals = [int(x) for x in parts]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
    return sum(vals), idle


def _sys_sampler() -> None:
    prev_total, prev_idle = _read_cpu()
    while True:
        time.sleep(30)
        try:
            total, idle = _read_cpu()
            dt, di = total - prev_total, idle - prev_idle
            prev_total, prev_idle = total, idle
            cpu = round(100 * (1 - di / dt), 1) if dt > 0 else 0.0
            mem = {}
            for line in Path("/proc/meminfo").read_text().splitlines():
                k, v = line.split(":", 1)
                mem[k] = int(v.strip().split()[0])
            mem_pct = round(100 * (1 - mem.get("MemAvailable", 0) / mem.get("MemTotal", 1)), 1)
            du = shutil.disk_usage("/")
            _SYS_SAMPLES.append({
                "ts": int(time.time()),
                "cpu": cpu,
                "mem": mem_pct,
                "load": round(os.getloadavg()[0], 2),
                "disk": round(100 * du.used / du.total, 1),
            })
        except Exception:
            pass


threading.Thread(target=_sys_sampler, daemon=True).start()


# ---------------------------------------------------------------- 推荐源 & 公版内容库存储
FEEDS_FILE = Path(os.environ.get("LEXORA_FEEDS_FILE", _cache_dir / "feeds.json"))
LIB_DIR = Path(os.environ.get("LEXORA_LIBRARY_DIR", _cache_dir / "library"))
LIB_META = LIB_DIR / "library.json"
LIB_DIR.mkdir(parents=True, exist_ok=True)
_STORE_LOCK = threading.Lock()


def _load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def _save_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)
_whisper_model = None
_whisper_lock = threading.Lock()
_piper_voices: dict = {}
_piper_lock = threading.Lock()


def _piper_onnx(voice: str | None = None) -> Path:
    return PIPER_DIR / f"{voice or PIPER_VOICE}.onnx"


def _available_voices() -> list[str]:
    if not PIPER_DIR.exists():
        return []
    return sorted(p.stem for p in PIPER_DIR.glob("*.onnx"))


def _has_piper() -> bool:
    if FAKE:
        return True
    if not _piper_onnx().exists():
        return False
    try:
        import piper  # noqa: F401
        return True
    except ImportError:
        return False


def _get_piper(voice: str | None = None):
    key = voice or PIPER_VOICE
    with _piper_lock:
        if key not in _piper_voices:
            from piper import PiperVoice  # lazy
            onnx = _piper_onnx(key)
            _piper_voices[key] = PiperVoice.load(str(onnx), config_path=f"{onnx}.json")
        return _piper_voices[key]


def _silent_wav(seconds: float = 0.3, rate: int = 22050) -> bytes:
    import io
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return buf.getvalue()


def _get_whisper():
    global _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            from faster_whisper import WhisperModel  # lazy: heavy import
            _whisper_model = WhisperModel(
                WHISPER_MODEL, compute_type=WHISPER_COMPUTE,
                cpu_threads=WHISPER_THREADS, num_workers=1,
            )
        return _whisper_model


def _fmt_ts(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


FAKE_VTT = """WEBVTT

00:00:00.000 --> 00:00:02.400
This is a fake transcription for testing.

00:00:02.400 --> 00:00:05.100
Replace it by running without LEXORA_FAKE.
"""


def _run_transcribe(job: Job, media: Path, language: str) -> None:
    try:
        job.status = "queued"
        with _TRANSCRIBE_SEM:
            job.status = "running"
            out = WORK_DIR / f"{job.id}.vtt"
            if FAKE:
                time.sleep(0.2)
                out.write_text(FAKE_VTT, encoding="utf-8")
            else:
                model = _get_whisper()
                segments, info = model.transcribe(
                    str(media), language=language or None, vad_filter=True, beam_size=1,
                    # 新闻/播客常有片头音乐：不携带上文可避免幻觉循环，还略快
                    condition_on_previous_text=False,
                    # 词级时间戳：分段级的 end 常吞掉最后一个词导致切片截早，
                    # 用首词/末词的精确时间重写段边界（约慢 15%，换句界精准）
                    word_timestamps=True,
                )
                total = max(1.0, getattr(info, "duration", 0.0) or 1.0)
                lines = ["WEBVTT", ""]
                for seg in segments:
                    words = getattr(seg, "words", None) or []
                    w_start = words[0].start if words else seg.start
                    w_end = max(words[-1].end, words[-1].start + 0.12) if words else seg.end
                    lines.append(f"{_fmt_ts(w_start)} --> {_fmt_ts(w_end)}")
                    lines.append(seg.text.strip())
                    lines.append("")
                    job.progress = min(0.99, w_end / total)
                out.write_text("\n".join(lines), encoding="utf-8")
        job.result_path = out
        job.progress = 1.0
        job.status = "done"
        _record(job.type, job.caller, job.created, True)
    except Exception as e:  # noqa: BLE001 — job errors surface to the client
        job.status = "failed"
        job.error = str(e)
        _record(job.type, job.caller, job.created, False, str(e)[:200])
    finally:
        media.unlink(missing_ok=True)


def _run_clip(job: Job, media: Path, segments: list) -> None:
    """ffmpeg 按段切 mp3 并打包 zip（name/start/end 必填）。"""
    import subprocess
    import zipfile
    try:
        job.status = "running"
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg not installed")
        out_zip = WORK_DIR / f"{job.id}.zip"
        tmp_dir = WORK_DIR / f"{job.id}_clips"
        tmp_dir.mkdir(exist_ok=True)
        total = max(1, len(segments))
        with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_STORED) as zf:
            for i, seg in enumerate(segments):
                name = str(seg.get("name", f"clip{i:02d}"))
                start = float(seg["start"])
                end = float(seg["end"])
                dur = max(0.2, end - start)
                clip = tmp_dir / f"{name}.mp3"
                cmd = [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-ss", f"{max(0.0, start - 0.05):.2f}", "-t", f"{dur + 0.1:.2f}",
                    "-i", str(media), "-vn",
                    "-acodec", "libmp3lame", "-q:a", "4", str(clip),
                ]
                subprocess.run(cmd, check=True, timeout=120)
                zf.write(clip, f"{name}.mp3")
                clip.unlink(missing_ok=True)
                job.progress = (i + 1) / total
        shutil.rmtree(tmp_dir, ignore_errors=True)
        job.result_path = out_zip
        job.status = "done"
        _record(job.type, job.caller, job.created, True)
    except Exception as e:  # noqa: BLE001
        job.status = "failed"
        job.error = str(e)
        _record(job.type, job.caller, job.created, False, str(e)[:200])
    finally:
        media.unlink(missing_ok=True)


def _run_ytmedia(job: Job, video_id: str, want_video: bool) -> None:
    """yt-dlp 下载 YouTube 媒体：want_video=True → 720p mp4；否则音轨转 mp3（128k）。"""
    import subprocess
    try:
        job.status = "running"
        ext = "mp4" if want_video else "mp3"
        out = WORK_DIR / f"{job.id}.{ext}"
        if FAKE:
            if want_video:
                subprocess.run(
                    ["ffmpeg", "-y", "-loglevel", "error",
                     "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2",
                     "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono",
                     "-shortest", str(out)],
                    check=True, timeout=30,
                )
            else:
                subprocess.run(
                    ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                     "-i", "anullsrc=r=22050:cl=mono", "-t", "2", str(out)],
                    check=True, timeout=30,
                )
        else:
            from yt_dlp import YoutubeDL  # type: ignore

            def hook(d: dict) -> None:
                if d.get("status") == "downloading":
                    tb = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                    if tb:
                        job.progress = min(0.9, (d.get("downloaded_bytes", 0) / tb) * 0.9)
                elif d.get("status") == "finished":
                    job.progress = 0.92

            opts = {
                **_ytdlp_base_opts(),
                "outtmpl": str(WORK_DIR / f"{job.id}.%(ext)s"),
                "progress_hooks": [hook],
            }
            if want_video:
                opts["format"] = (
                    "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]"
                    "/best[height<=720][ext=mp4]/best[ext=mp4]/best"
                )
                opts["merge_output_format"] = "mp4"
            else:
                opts["format"] = "bestaudio/best"
                opts["postprocessors"] = [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "128",
                }]
            with YoutubeDL(opts) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
            if not out.exists():
                raise RuntimeError(f"{ext} not produced")
        job.result_path = out
        job.progress = 1.0
        job.status = "done"
        _record(job.type, job.caller, job.created, True)
    except Exception as e:  # noqa: BLE001
        job.status = "failed"
        job.error = str(e)[:300]
        _record(job.type, job.caller, job.created, False, str(e)[:200])


COOKIES_FILE = Path(os.environ.get("LEXORA_COOKIES", "/app/cookies.txt"))


def _ytdlp_base_opts() -> dict:
    """全部 yt-dlp 调用共用：防限流 + cookies（绕过 YouTube 的 bot 验证）。"""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "sleep_interval_requests": 1,
        "retries": 5,
        "socket_timeout": 30,
    }
    if COOKIES_FILE.exists():
        opts["cookiefile"] = str(COOKIES_FILE)
    return opts


def _has_ytdlp() -> bool:
    try:
        import yt_dlp  # noqa: F401
        return True
    except ImportError:
        return False


# ---------------------------------------------------------------- endpoints

@app.get("/v1/capabilities")
def capabilities(caller: str = Depends(require_auth)) -> JSONResponse:
    has_whisper = FAKE
    if not FAKE:
        try:
            import faster_whisper  # noqa: F401
            has_whisper = True
        except ImportError:
            has_whisper = False
    return JSONResponse({
        "apiVersion": API_VERSION,
        "name": "elp-worker",
        "features": {
            "transcribe": has_whisper,
            "tts": _has_piper(),
            "clip": shutil.which("ffmpeg") is not None,
            "subtitle": (FAKE or _has_ytdlp()) and caller == "admin",
            "ytaudio": (FAKE or _has_ytdlp()) and shutil.which("ffmpeg") is not None and caller == "admin",
            "cookies": COOKIES_FILE.exists() and caller == "admin",
        },
        "models": {"whisper": WHISPER_MODEL, "compute": WHISPER_COMPUTE, "piper": PIPER_VOICE},
        "voices": _available_voices() or ([PIPER_VOICE] if FAKE else []),
        "fake": FAKE,
    })


@app.post("/v1/jobs")
async def create_job(
    type: str = Form(...),
    file: UploadFile = File(...),
    options: str = Form("{}"),
    caller: str = Depends(require_auth),
) -> JSONResponse:
    if caller != "admin":
        _quota_take(caller, "转写/切片", LICENSED_DAILY_JOBS)
    if type not in ("transcribe", "clip"):
        raise HTTPException(status_code=400, detail=f"unsupported job type: {type}")
    opts = json.loads(options or "{}")
    job = Job(id=uuid.uuid4().hex, type=type, caller=caller)
    media = WORK_DIR / f"{job.id}_{Path(file.filename or 'media').name}"
    with media.open("wb") as fh:
        while chunk := await file.read(1 << 20):
            fh.write(chunk)
    with JOBS_LOCK:
        JOBS[job.id] = job
    if type == "transcribe":
        threading.Thread(
            target=_run_transcribe, args=(job, media, opts.get("language", "en")), daemon=True,
        ).start()
    else:
        threading.Thread(
            target=_run_clip, args=(job, media, opts.get("segments", [])), daemon=True,
        ).start()
    return JSONResponse({"id": job.id, "status": job.status})


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(require_auth)])
def job_status(job_id: str) -> JSONResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return JSONResponse({
        "id": job.id, "type": job.type, "status": job.status,
        "progress": round(job.progress, 3), "error": job.error,
    })


@app.get("/v1/jobs/{job_id}/result", dependencies=[Depends(require_auth)])
def job_result(job_id: str) -> FileResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status != "done" or not job.result_path:
        raise HTTPException(status_code=409, detail=f"job is {job.status}")
    if job.result_path.suffix == ".zip":
        return FileResponse(job.result_path, media_type="application/zip", filename="clips.zip")
    if job.result_path.suffix == ".mp3":
        return FileResponse(job.result_path, media_type="audio/mpeg", filename="audio.mp3")
    if job.result_path.suffix == ".mp4":
        return FileResponse(job.result_path, media_type="video/mp4", filename="video.mp4")
    return FileResponse(job.result_path, media_type="text/vtt", filename="transcript.vtt")


@app.delete("/v1/jobs/{job_id}", dependencies=[Depends(require_auth)])
def cancel_job(job_id: str) -> JSONResponse:
    # MVP：faster-whisper 不支持中断，仅从列表移除。
    with JOBS_LOCK:
        JOBS.pop(job_id, None)
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------- tts

from pydantic import BaseModel
from fastapi.responses import Response


class YtAudioRequest(BaseModel):
    video_id: str
    # True → 下载 720p mp4 视频；False/缺省 → 只要 mp3 音轨
    video: bool = False


@app.post("/v1/ytaudio")
def ytaudio(req: YtAudioRequest, caller: str = Depends(require_auth)) -> JSONResponse:
    """异步任务：下载 YouTube 音轨为 mp3（结果走 /v1/jobs/{id}/result）。"""
    if caller != "admin":
        raise HTTPException(status_code=403, detail="托管 worker 未开放 YouTube 功能，请自托管")
    vid = req.video_id.strip()
    if not vid or len(vid) > 20:
        raise HTTPException(status_code=400, detail="bad video_id")
    if not FAKE and not _has_ytdlp():
        raise HTTPException(status_code=501, detail="yt-dlp not installed (pip install yt-dlp)")
    if not shutil.which("ffmpeg"):
        raise HTTPException(status_code=501, detail="ffmpeg not installed")
    job = Job(id=uuid.uuid4().hex, type="ytaudio", caller=caller)
    with JOBS_LOCK:
        JOBS[job.id] = job
    threading.Thread(target=_run_ytmedia, args=(job, vid, bool(req.video)), daemon=True).start()
    return JSONResponse({"job_id": job.id})


class SubtitleRequest(BaseModel):
    video_id: str
    # 语言偏好；yt-dlp 会先取人工字幕，没有再取自动字幕
    lang: str = "en"


@app.post("/v1/subtitle")
def subtitle(req: SubtitleRequest, caller: str = Depends(require_auth)) -> JSONResponse:
    """只拉 YouTube 字幕（不下载音视频）：人工字幕优先，ASR 自动字幕兜底。"""
    if caller != "admin":
        raise HTTPException(status_code=403, detail="托管 worker 未开放 YouTube 功能，请自托管")
    _t0 = time.time()
    vid = req.video_id.strip()
    if not vid or len(vid) > 20:
        raise HTTPException(status_code=400, detail="bad video_id")
    if FAKE:
        _record("subtitle", caller, _t0, True)
        return JSONResponse({"vtt": FAKE_VTT, "auto": False})
    if not _has_ytdlp():
        raise HTTPException(status_code=501, detail="yt-dlp not installed (pip install yt-dlp)")
    import glob
    import tempfile
    from yt_dlp import YoutubeDL  # type: ignore

    url = f"https://www.youtube.com/watch?v={vid}"
    lang = req.lang or "en"
    # 旧套件验证过的要点：
    # 1) 绝不能用 "en.*"——会匹配几十条 en-xx 机器翻译轨道，逐个下载直接被打到 HTTP 429
    # 2) ignore_no_formats_error：只要字幕不下视频流时必须带，否则格式列表拿不到就中断
    # 3) sleep/retries 防限流
    langs = [lang, f"{lang}-orig", f"{lang}-US", f"{lang}-GB"]
    with tempfile.TemporaryDirectory() as td:
        base_opts = {
            **_ytdlp_base_opts(),
            "skip_download": True,
            "ignore_no_formats_error": True,
            "subtitleslangs": langs,
            "subtitlesformat": "vtt",
            "outtmpl": f"{td}/sub.%(ext)s",
        }

        def pick_vtt() -> str | None:
            # 优先级：人工 en > en-US > en-GB > en-orig（orig 多为自动轨）
            from pathlib import Path as _P
            for cand in (f"sub.{lang}.vtt", f"sub.{lang}-US.vtt", f"sub.{lang}-GB.vtt", f"sub.{lang}-orig.vtt"):
                p = _P(td) / cand
                if p.exists():
                    return str(p)
            files = sorted(glob.glob(f"{td}/*.vtt"))
            return files[0] if files else None

        # 先取人工字幕，没有再取自动字幕（两步分开，避免自动字幕覆盖人工）
        for auto, opts in (
            (False, {**base_opts, "writesubtitles": True}),
            (True, {**base_opts, "writeautomaticsub": True}),
        ):
            try:
                with YoutubeDL(opts) as ydl:
                    ydl.download([url])
            except Exception as e:  # noqa: BLE001
                if auto:
                    raise HTTPException(status_code=502, detail=f"yt-dlp failed: {str(e)[:200]}")
                continue
            picked = pick_vtt()
            if picked:
                text = open(picked, encoding="utf-8", errors="replace").read()
                if "WEBVTT" in text:
                    _record("subtitle", caller, _t0, True)
                    return JSONResponse({"vtt": text, "auto": auto})
    raise HTTPException(status_code=404, detail="no subtitles for this video")


class TtsRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    # 语速：Piper length_scale，>1 更慢。单词朗读客户端会传 ~1.12，避免急促。
    speed: float = 1.0


def _pad_wav(data: bytes, lead: float = 0.12, tail: float = 0.18) -> bytes:
    """首尾加静音垫：避免播放设备起播裁掉头音（听感发闷/吞字）与收尾过急。"""
    import io
    import wave
    try:
        with wave.open(io.BytesIO(data), "rb") as src:
            params = src.getparams()
            frames = src.readframes(src.getnframes())
        unit = params.sampwidth * params.nchannels
        lead_b = b"\x00" * (int(params.framerate * lead) * unit)
        tail_b = b"\x00" * (int(params.framerate * tail) * unit)
        out = io.BytesIO()
        with wave.open(out, "wb") as dst:
            dst.setparams(params)
            dst.writeframes(lead_b + frames + tail_b)
        return out.getvalue()
    except Exception:  # noqa: BLE001 — 垫失败就原样返回
        return data


@app.post("/v1/tts")
def tts(req: TtsRequest, caller: str = Depends(require_auth)) -> Response:
    if caller != "admin":
        _quota_take(caller, "TTS", LICENSED_DAILY_TTS)
    _t0 = time.time()
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    if len(text) > 2000:
        raise HTTPException(status_code=400, detail="text too long (<=2000 chars)")
    speed = min(2.0, max(0.5, req.speed or 1.0))
    if FAKE:
        _record("tts", caller, _t0, True)
        return Response(content=_silent_wav(), media_type="audio/wav")
    req_voice = (req.voice or "").strip() or None
    if req_voice and not _piper_onnx(req_voice).exists():
        req_voice = None  # 未知音色回退默认
    if not _has_piper():
        raise HTTPException(status_code=501, detail=f"piper voice missing: {_piper_onnx()}")
    import io
    import wave
    try:
        voice = _get_piper(req_voice)
        buf = io.BytesIO()
        # piper-tts 的两代 API：1.3+ 为 synthesize_wav，1.2 为 synthesize(text, wav)
        if hasattr(voice, "synthesize_wav"):
            syn_config = None
            if abs(speed - 1.0) > 1e-3:
                try:
                    from piper import SynthesisConfig  # 1.3+
                    syn_config = SynthesisConfig(length_scale=speed)
                except Exception:  # noqa: BLE001
                    syn_config = None
            with wave.open(buf, "wb") as wav:
                if syn_config is not None:
                    voice.synthesize_wav(text, wav, syn_config=syn_config)
                else:
                    voice.synthesize_wav(text, wav)
        else:
            with wave.open(buf, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(getattr(voice.config, "sample_rate", 22050))
                try:
                    voice.synthesize(text, wav, length_scale=speed)
                except TypeError:
                    voice.synthesize(text, wav)
        data = buf.getvalue()
        if len(data) < 1000:
            raise RuntimeError(f"synthesized only {len(data)} bytes")
        _record("tts", caller, _t0, True)
        return Response(content=_pad_wav(data), media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — 细节透给客户端便于排查
        raise HTTPException(status_code=500, detail=f"piper failed: {type(e).__name__}: {e}")


# ---------------------------------------------------------------- 运维页面（/admin）
OPS_COOKIE = hashlib.sha256(f"lexora-ops:{TOKEN}".encode()).hexdigest()
_LOGIN_FAILS: dict = {}


def _is_admin_request(request: Request) -> bool:
    if request.headers.get("authorization", "") == f"Bearer {TOKEN}":
        return True
    return hmac.compare_digest(request.cookies.get("lexora_ops", ""), OPS_COOKIE)


def require_admin(request: Request) -> None:
    """站长专用：Bearer 管理 token，或登录页签发的 HttpOnly cookie。"""
    if not _is_admin_request(request):
        raise HTTPException(status_code=401, detail="ops auth required")


@app.get("/healthz")
def healthz() -> JSONResponse:
    return JSONResponse({"apiVersion": API_VERSION, "model": WHISPER_MODEL})


@app.post("/admin/login")
def admin_login(request: Request, body: dict) -> JSONResponse:
    ip = request.client.host if request.client else "?"
    now = time.time()
    rec = _LOGIN_FAILS.get(ip)
    if rec and rec[0] >= 5 and now - rec[1] < 600:
        raise HTTPException(status_code=429, detail="失败次数过多，10 分钟后再试")
    if rec and now - rec[1] >= 600:
        _LOGIN_FAILS.pop(ip, None)
    if not hmac.compare_digest(str(body.get("token", "")), TOKEN):
        cur = _LOGIN_FAILS.setdefault(ip, [0, now])
        cur[0] += 1
        raise HTTPException(status_code=401, detail="token 不正确")
    _LOGIN_FAILS.pop(ip, None)
    resp = JSONResponse({"ok": True})
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(
        "lexora_ops", OPS_COOKIE, httponly=True, samesite="strict",
        secure=secure, max_age=7 * 86400 if body.get("remember") else None,
    )
    return resp


@app.post("/admin/logout")
def admin_logout() -> JSONResponse:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("lexora_ops")
    return resp


def _pct(sorted_ms: list, q: float) -> int:
    if not sorted_ms:
        return 0
    return sorted_ms[min(len(sorted_ms) - 1, int(q * len(sorted_ms)))]


@app.get("/admin/api/stats", dependencies=[Depends(require_admin)])
def admin_stats() -> JSONResponse:
    now = time.time()
    day0 = now - 86400
    week0 = now - 7 * 86400
    with _mx_lock:
        rows = _mx_conn.execute(
            "SELECT ts, kind, caller, duration_ms, ok, detail FROM events WHERE ts > ? ORDER BY ts DESC",
            (week0,),
        ).fetchall()
    kinds: dict = {}
    users: dict = {}
    for ts, kind, caller, ms, ok, _d in rows:
        k = kinds.setdefault(kind, {"today": 0, "week": 0, "fail": 0, "ms": []})
        k["week"] += 1
        if ts > day0:
            k["today"] += 1
        if not ok:
            k["fail"] += 1
        else:
            k["ms"].append(ms)
        if caller.startswith("pro:"):
            u = users.setdefault(caller[4:], {"today": 0, "week": 0, "last": 0})
            u["week"] += 1
            if ts > day0:
                u["today"] += 1
            u["last"] = max(u["last"], ts)
    for k in kinds.values():
        k["ms"].sort()
        k["avg_ms"] = int(sum(k["ms"]) / len(k["ms"])) if k["ms"] else 0
        k["p50_ms"] = _pct(k["ms"], 0.5)
        k["p95_ms"] = _pct(k["ms"], 0.95)
        del k["ms"]
    issued = []
    if ISSUED_FILE.exists():
        for line in ISSUED_FILE.read_text(encoding="utf-8").splitlines():
            try:
                issued.append(json.loads(line))
            except Exception:  # noqa: BLE001
                pass
    active = [i for i in issued if i.get("exp", 0) > now * 1000]
    revenue = sum(float(i.get("price", 0) or 0) for i in issued)
    sys_now = _SYS_SAMPLES[-1] if _SYS_SAMPLES else {}
    return JSONResponse({
        "now": int(now),
        "uptime_s": int(now - STARTED_AT),
        "apiVersion": API_VERSION,
        "whisper": {"model": WHISPER_MODEL, "threads": WHISPER_THREADS},
        "system": {"now": sys_now, "history": list(_SYS_SAMPLES)},
        "jobs": {
            "kinds": kinds,
            "recent": [
                {"ts": int(ts), "kind": kind, "caller": caller, "ms": ms, "ok": bool(ok), "detail": d}
                for ts, kind, caller, ms, ok, d in rows[:20]
            ],
        },
        "licensedUsers": [
            {"email": e, **v} for e, v in sorted(users.items(), key=lambda kv: -kv[1]["last"])
        ],
        "issued": {
            "total": len(issued),
            "active": len(active),
            "revenue": revenue,
            "list": sorted(issued, key=lambda i: -(i.get("iat") or 0))[:50],
        },
    })


from admin_ui import ADMIN_HTML, LOGIN_HTML  # noqa: E402


@app.get("/admin")
def admin_page(request: Request) -> Response:
    html = ADMIN_HTML if _is_admin_request(request) else LOGIN_HTML
    return Response(content=html, media_type="text/html; charset=utf-8")


# ---------------------------------------------------------------- 推荐源
@app.get("/v1/recommended-feeds")
def recommended_feeds() -> JSONResponse:
    """公开端点：插件启动时拉取；仅返回启用项。无任何鉴权与标识。"""
    data = _load_json(FEEDS_FILE, {"version": 0, "feeds": []})
    feeds = [f for f in data.get("feeds", []) if f.get("enabled", True)]
    return JSONResponse({"version": data.get("version", 0), "updatedAt": data.get("updatedAt"), "feeds": feeds})


@app.get("/admin/api/feeds", dependencies=[Depends(require_admin)])
def feeds_get() -> JSONResponse:
    return JSONResponse(_load_json(FEEDS_FILE, {"version": 0, "feeds": []}))


@app.put("/admin/api/feeds", dependencies=[Depends(require_admin)])
def feeds_put(body: dict) -> JSONResponse:
    feeds = body.get("feeds")
    if not isinstance(feeds, list) or len(feeds) > 200:
        raise HTTPException(status_code=400, detail="feeds 必须是列表（≤200）")
    clean = []
    for f in feeds:
        url = str(f.get("url", ""))[:500]
        if not url.startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail=f"地址不合法：{url[:60]}")
        clean.append({
            "id": str(f.get("id", ""))[:40] or uuid.uuid4().hex[:8],
            "name": str(f.get("name", ""))[:80],
            "url": url,
            "type": f.get("type") if f.get("type") in ("rss", "bilibili", "article", "youtube") else "rss",
            "group": str(f.get("group", ""))[:40],
            # region: cn=国内直连 / global=境外（插件按用户网络探测决定是否展示）
            "region": f.get("region") if f.get("region") in ("cn", "global") else ("global" if "youtube" in url else "cn"),
            "enabled": bool(f.get("enabled", True)),
        })
    with _STORE_LOCK:
        old = _load_json(FEEDS_FILE, {"version": 0})
        data = {"version": int(old.get("version", 0)) + 1,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "feeds": clean}
        _save_json(FEEDS_FILE, data)
    return JSONResponse({"ok": True, "version": data["version"]})


# ---------------------------------------------------------------- 公版内容库
_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
_SAFE_NAME = re.compile(r"^[^/\\]{1,120}$")
LIB_EXT = {".mp3", ".m4a", ".mp4", ".vtt", ".srt", ".txt"}


def _lib_meta():
    return _load_json(LIB_META, {"collections": []})


def _lib_col(meta, cid):
    for c in meta["collections"]:
        if c["id"] == cid:
            return c
    raise HTTPException(status_code=404, detail="合集不存在")


@app.get("/v1/library")
def library_public() -> JSONResponse:
    """公开端点：已发布的公版合集（内容为公有领域）。"""
    meta = _lib_meta()
    cols = [{k: c[k] for k in ("id", "title", "source", "level", "desc", "preview", "freeGen", "files")}
            for c in meta["collections"] if c.get("published")]
    return JSONResponse({"collections": cols})


@app.get("/v1/library/{cid}/file/{name}")
def library_file(cid: str, name: str):
    if not _SAFE_ID.match(cid) or not _SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail="bad path")
    meta = _lib_meta()
    col = _lib_col(meta, cid)
    if not col.get("published"):
        raise HTTPException(status_code=404, detail="合集未发布")
    path = LIB_DIR / cid / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    from fastapi.responses import FileResponse
    return FileResponse(path)


@app.get("/admin/api/library", dependencies=[Depends(require_admin)])
def library_admin_list() -> JSONResponse:
    meta = _lib_meta()
    used = sum(f.stat().st_size for f in LIB_DIR.rglob("*") if f.is_file())
    return JSONResponse({"collections": meta["collections"], "usedBytes": used})


@app.post("/admin/api/library", dependencies=[Depends(require_admin)])
def library_create(body: dict) -> JSONResponse:
    title = str(body.get("title", "")).strip()[:80]
    if not title:
        raise HTTPException(status_code=400, detail="标题必填")
    col = {"id": uuid.uuid4().hex[:10], "title": title,
           "source": str(body.get("source", "")).strip()[:120],
           "level": str(body.get("level", "B1"))[:8],
           "desc": str(body.get("desc", ""))[:500],
           "preview": True, "freeGen": False, "published": False,
           "createdAt": datetime.now(timezone.utc).isoformat(), "files": []}
    with _STORE_LOCK:
        meta = _lib_meta()
        meta["collections"].insert(0, col)
        _save_json(LIB_META, meta)
    (LIB_DIR / col["id"]).mkdir(parents=True, exist_ok=True)
    return JSONResponse(col)


@app.patch("/admin/api/library/{cid}", dependencies=[Depends(require_admin)])
def library_patch(cid: str, body: dict) -> JSONResponse:
    with _STORE_LOCK:
        meta = _lib_meta()
        col = _lib_col(meta, cid)
        for k in ("title", "source", "level", "desc"):
            if k in body:
                col[k] = str(body[k])[:500]
        for k in ("preview", "freeGen", "published"):
            if k in body:
                col[k] = bool(body[k])
        _save_json(LIB_META, meta)
    return JSONResponse(col)


@app.delete("/admin/api/library/{cid}", dependencies=[Depends(require_admin)])
def library_delete(cid: str) -> JSONResponse:
    if not _SAFE_ID.match(cid):
        raise HTTPException(status_code=400, detail="bad id")
    with _STORE_LOCK:
        meta = _lib_meta()
        _lib_col(meta, cid)
        meta["collections"] = [c for c in meta["collections"] if c["id"] != cid]
        _save_json(LIB_META, meta)
    shutil.rmtree(LIB_DIR / cid, ignore_errors=True)
    return JSONResponse({"ok": True})


@app.post("/admin/api/library/{cid}/files", dependencies=[Depends(require_admin)])
async def library_upload(cid: str, files: list[UploadFile] = File(...)) -> JSONResponse:
    if not _SAFE_ID.match(cid):
        raise HTTPException(status_code=400, detail="bad id")
    with _STORE_LOCK:
        meta = _lib_meta()
        col = _lib_col(meta, cid)
    dest_dir = LIB_DIR / cid
    dest_dir.mkdir(parents=True, exist_ok=True)
    added = []
    for up in files[:50]:
        name = Path(up.filename or "file").name[:120]
        ext = Path(name).suffix.lower()
        if ext not in LIB_EXT:
            raise HTTPException(status_code=400, detail=f"不支持的格式：{name}")
        dest = dest_dir / name
        size = 0
        with dest.open("wb") as out:
            while chunk := await up.read(1 << 20):
                size += len(chunk)
                if size > 2 * 1024 ** 3:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail=f"{name} 超过 2GB")
                out.write(chunk)
        added.append({"name": name, "size": size, "type": ext.lstrip(".")})
    with _STORE_LOCK:
        meta = _lib_meta()
        col = _lib_col(meta, cid)
        existing = {f["name"] for f in col["files"]}
        col["files"] = [f for f in col["files"] if f["name"] not in {a["name"] for a in added}] + added
        col["files"].sort(key=lambda f: f["name"])
        _save_json(LIB_META, meta)
    return JSONResponse({"ok": True, "added": added})
