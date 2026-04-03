FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Pi coding agent CLI globally
RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /app

# Install ws for the bridge server
RUN npm init -y && npm install ws

# Copy bridge server
COPY bridge.mjs .

# Copy baked-in skills
COPY skills/ /skills/

# Create non-root user
RUN useradd -m -s /bin/bash pi
RUN mkdir -p /workspace && chown pi:pi /workspace

ENV NODE_ENV=production
ENV BRIDGE_PORT=7880
ENV SKILLS_DIR=/skills

USER pi

EXPOSE 7880

CMD ["node", "bridge.mjs"]
