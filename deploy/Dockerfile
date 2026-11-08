# Roku Detox in a container, for a NAS (Synology, Unraid, ...) or any always-on Linux box.
# Run it with host networking so it can find the TV and be reached from your Wi-Fi:
#   docker compose -f deploy/docker-compose.yml up -d
FROM python:3.12-alpine
WORKDIR /app
COPY roku_detox.py index.html ./
COPY roku-app ./roku-app
VOLUME /data
EXPOSE 8642
CMD ["python3", "-u", "roku_detox.py", "--no-browser", "--household", "--data", "/data"]
