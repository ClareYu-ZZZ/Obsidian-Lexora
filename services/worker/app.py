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
import json
import os
import secrets
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

API_VERSION = "1.1"
FAKE = os.environ.get("LEXORA_FAKE") == "1"
WHISPER_MODEL = os.environ.get("LEXORA_WHISPER_MODEL", "small")
PIPER_VOICE = os.environ.get("LEXORA_PIPER_VOICE", "en_US-ryan-high")
PIPER_DIR = Path(os.environ.get("LEXORA_PIPER_DIR", "/voices"))
WHISPER_COMPUTE = os.environ.get("LEXORA_WHISPER_COMPUTE", "int8")
WHISPER_THREADS = int(os.environ.get("LEXORA_WHISPER_THREADS", "4"))
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
        job.status = "running"
        out = WORK_DIR / f"{job.id}.vtt"
        if FAKE:
            time.sleep(0.2)
            out.write_text(FAKE_VTT, encoding="utf-8")
        else:
            model = _get_whisper()
            segments, info = model.transcribe(
                str(media), language=language or None, vad_filter=True, beam_size=1,
            )
            total = max(1.0, getattr(info, "duration", 0.0) or 1.0)
            lines = ["WEBVTT", ""]
            for seg in segments:
                lines.append(f"{_fmt_ts(seg.start)} --> {_fmt_ts(seg.end)}")
                lines.append(seg.text.strip())
                lines.append("")
                job.progress = min(0.99, seg.end / total)
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
def require_admin(request: Request) -> None:
    """站长专用：Bearer 管理 token，或浏览器 Basic 认证（任意用户名 + 管理 token 作密码）。"""
    header = request.headers.get("authorization", "")
    if header == f"Bearer {TOKEN}":
        return
    if header.startswith("Basic "):
        try:
            if base64.b64decode(header[6:]).decode().split(":", 1)[1] == TOKEN:
                return
        except Exception:  # noqa: BLE001
            pass
    raise HTTPException(
        status_code=401,
        detail="ops auth required",
        headers={"WWW-Authenticate": 'Basic realm="lexora-ops"'},
    )


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


ADMIN_HTML = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lexora 运维</title><style>
:root{color-scheme:dark}body{margin:0;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;background:#10141a;color:#dde3ea}
.wrap{max-width:1080px;margin:0 auto;padding:24px 16px}h1{font-size:18px;margin:0 0 4px}
.muted{color:#8a94a3;font-size:12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.card{background:#1a2029;border:1px solid #28303c;border-radius:10px;padding:12px 14px}
.card b{display:block;font-size:22px;margin-top:2px}.card span{color:#8a94a3;font-size:12px}
h2{font-size:14px;margin:22px 0 8px;color:#aab4c2}table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #222a35}th{color:#8a94a3;font-weight:500}
.ok{color:#5dd39e}.bad{color:#ff7a7a}svg{display:block;width:100%;height:72px;background:#1a2029;border:1px solid #28303c;border-radius:10px}
</style></head><body><div class="wrap">
<h1>Lexora worker 运维</h1><div class="muted" id="meta">加载中…</div>
<div class="cards" id="cards"></div>
<h2>CPU / 内存（24h，30s 采样）</h2><svg id="spark" viewBox="0 0 600 72" preserveAspectRatio="none"></svg>
<h2>任务统计（7 天）</h2><table id="kinds"><thead><tr><th>类型</th><th>今日</th><th>7天</th><th>失败</th><th>均耗时</th><th>P50</th><th>P95</th></tr></thead><tbody></tbody></table>
<h2>付费用户活跃（worker 侧，7 天）</h2><table id="users"><thead><tr><th>邮箱</th><th>今日调用</th><th>7天调用</th><th>最近活跃</th></tr></thead><tbody></tbody></table>
<h2>已签发订阅<span class="muted">（来自 issued.jsonl，未挂载则为空）</span></h2><table id="issued"><thead><tr><th>邮箱</th><th>签发</th><th>到期</th><th>价格</th><th>状态</th></tr></thead><tbody></tbody></table>
<h2>近期任务</h2><table id="recent"><thead><tr><th>时间</th><th>类型</th><th>调用方</th><th>耗时</th><th>结果</th></tr></thead><tbody></tbody></table>
</div><script>
const fmt=(ts)=>new Date(ts*1000).toLocaleString('zh-CN',{hour12:false});
const dur=(ms)=>ms>=60000?(ms/60000).toFixed(1)+' 分':ms>=1000?(ms/1000).toFixed(1)+' 秒':ms+' ms';
async function load(){
  const r=await fetch('admin/api/stats'.startsWith('/')?'/admin/api/stats':'/admin/api/stats');
  if(!r.ok){document.getElementById('meta').textContent='加载失败 HTTP '+r.status;return}
  const d=await r.json();
  const up=Math.floor(d.uptime_s/3600)+'h'+Math.floor(d.uptime_s%3600/60)+'m';
  document.getElementById('meta').textContent=`API v${d.apiVersion} · whisper ${d.whisper.model}×${d.whisper.threads}线程 · 运行 ${up} · 刷新于 ${fmt(d.now)}`;
  const s=d.system.now||{};
  const todayJobs=Object.values(d.jobs.kinds).reduce((n,k)=>n+k.today,0);
  document.getElementById('cards').innerHTML=[
    ['CPU',(s.cpu??'—')+'%'],['内存',(s.mem??'—')+'%'],['负载',s.load??'—'],['磁盘',(s.disk??'—')+'%'],
    ['今日任务',todayJobs],['在期订阅',d.issued.active],['累计收入','¥'+d.issued.revenue]
  ].map(([t,v])=>`<div class="card"><span>${t}</span><b>${v}</b></div>`).join('');
  const h=d.system.history;
  if(h.length>1){
    const xs=h.map((p,i)=>i/(h.length-1)*600);
    const line=(key,color)=>`<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${h.map((p,i)=>xs[i].toFixed(1)+','+(70-p[key]*0.68).toFixed(1)).join(' ')}"/>`;
    document.getElementById('spark').innerHTML=line('cpu','#5da9ff')+line('mem','#5dd39e');
  }
  document.querySelector('#kinds tbody').innerHTML=Object.entries(d.jobs.kinds).map(([k,v])=>
    `<tr><td>${k}</td><td>${v.today}</td><td>${v.week}</td><td class="${v.fail?'bad':''}">${v.fail}</td><td>${dur(v.avg_ms)}</td><td>${dur(v.p50_ms)}</td><td>${dur(v.p95_ms)}</td></tr>`).join('')||'<tr><td colspan=7 class="muted">暂无任务</td></tr>';
  document.querySelector('#users tbody').innerHTML=d.licensedUsers.map(u=>
    `<tr><td>${u.email}</td><td>${u.today}</td><td>${u.week}</td><td>${fmt(u.last)}</td></tr>`).join('')||'<tr><td colspan=4 class="muted">尚无付费用户调用</td></tr>';
  document.querySelector('#issued tbody').innerHTML=d.issued.list.map(i=>{
    const act=i.exp>Date.now();
    return `<tr><td>${i.email}</td><td>${i.iat?fmt(i.iat/1000):'—'}</td><td>${i.exp?fmt(i.exp/1000):'—'}</td><td>${i.price?'¥'+i.price:'—'}</td><td class="${act?'ok':'bad'}">${act?'在期':'已到期'}</td></tr>`;
  }).join('')||'<tr><td colspan=5 class="muted">未挂载 issued.jsonl</td></tr>';
  document.querySelector('#recent tbody').innerHTML=d.jobs.recent.map(e=>
    `<tr><td>${fmt(e.ts)}</td><td>${e.kind}</td><td>${e.caller.replace('pro:','')}</td><td>${dur(e.ms)}</td><td class="${e.ok?'ok':'bad'}">${e.ok?'成功':'失败 '+(e.detail||'')}</td></tr>`).join('')||'<tr><td colspan=5 class="muted">暂无记录</td></tr>';
}
load();setInterval(load,15000);
</script></body></html>"""


@app.get("/admin", dependencies=[Depends(require_admin)])
def admin_page() -> Response:
    return Response(content=ADMIN_HTML, media_type="text/html; charset=utf-8")
