FROM python:3.9-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Create storage directory for persistence
RUN mkdir -p /app/storage
ENV STORAGE_DIR=/app/storage

# Expose the port the app runs on
EXPOSE 5080

# Command to run the application
CMD ["python", "app.py"]
