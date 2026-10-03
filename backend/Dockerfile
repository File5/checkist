FROM python:3.13.16-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt \
    && python -m pip check \
    && useradd --create-home --uid 10001 checkist
COPY --chown=checkist:checkist . .
USER checkist
CMD ["celery", "-A", "config", "worker", "--loglevel=INFO", "--pool=prefork", "--concurrency=2", "--hostname=checkist@worker"]
