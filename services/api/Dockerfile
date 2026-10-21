# API image. Build from the repo root (the uv workspace):
#   docker build -f services/api/Dockerfile .
# Dependencies come from uv.lock only (--locked). The image holds no keys (hard rule 1).

FROM ghcr.io/astral-sh/uv:0.9@sha256:538e0b39736e7feae937a65983e49d2ab75e1559d35041f9878b7b7e51de91e4 AS uv

FROM python:3.14-slim@sha256:00ebdcac87ebf7fd62576d8bbe8f8f1e94198befcc4e38c4db9671e61e0dfcfe AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY packages packages
COPY services services
RUN uv sync --locked --no-dev --no-editable --package gajufreight-api

FROM python:3.14-slim@sha256:00ebdcac87ebf7fd62576d8bbe8f8f1e94198befcc4e38c4db9671e61e0dfcfe
RUN useradd --system --uid 10001 --no-create-home api
COPY --from=build /app/.venv /app/.venv
USER 10001
ENV PATH=/app/.venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]
CMD ["uvicorn", "gajufreight_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
