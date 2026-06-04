# Use a slim image to save RAM
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for NLP models if needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# CRITICAL: Install CPU-only torch to stay under the 1GB limit
COPY backend/requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir transformers safetensors && \
    pip install --no-cache-dir -r requirements.txt

COPY backend/ .

# Match this to your Northflank port configuration
EXPOSE 8080

CMD ["python", "main.py"]