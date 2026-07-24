FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir requests python-docx Pillow Flask

COPY app.py /app/app.py
COPY api_server.py /app/api_server.py
COPY x-word /app/x-word

EXPOSE 3011

ENTRYPOINT ["python", "app.py"]