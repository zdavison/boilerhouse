FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install the ws package for WebSocket support
RUN npm init -y && npm install ws

# Copy the bridge server (plain Node.js ESM — no build step)
COPY bridge.mjs .

# Create non-root user — claude refuses --dangerously-skip-permissions as root
RUN useradd -m -s /bin/bash claude
RUN mkdir -p /workspace && chown claude:claude /workspace

ENV NODE_ENV=production
ENV BRIDGE_PORT=7880
ENV WORKSPACE_DIR=/workspace

USER claude

EXPOSE 7880
