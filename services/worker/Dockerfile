FROM python:3.11-slim
# 大陆构建可传 --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL}
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir "yt-dlp[default,curl-cffi]"

# deno：yt-dlp 解 YouTube JS 签名挑战所需的运行时（无它会缺格式/被降级）
RUN apt-get update -qq && apt-get install -y -qq unzip \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && rm -rf /var/lib/apt/lists/*
# Piper 音色（MIT 数据，rhasspy/piper-voices）
RUN mkdir -p /voices && cd /voices && \
    curl -fsSLO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx && \
    curl -fsSLO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json && \
    curl -fsSLO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx && \
    curl -fsSLO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json && \
    curl -fsSLO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx && \
    curl -fsSLO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json
COPY app.py admin_ui.py .
EXPOSE 8321
# NAS 上以 -e LEXORA_TOKEN=xxx 固定 token；模型缓存挂载 /root/.cache 可持久化
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8321"]
