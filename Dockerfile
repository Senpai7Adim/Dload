# Stage 1: Build
FROM python:3.11-slim

# Install system dependencies: ffmpeg for audio/video merging
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Install Python dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app source
COPY www.youtube.com_cookies.txt* ./
COPY app/ ./app/
COPY static/ ./static/
COPY templates/ ./templates/

# Create downloads dir in /tmp (writable on all environments)
RUN mkdir -p /tmp/downloads

# Expose port
EXPOSE 10000

# Run the server
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "10000"]
