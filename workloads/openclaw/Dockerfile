FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install openclaw and its dependencies, then promote openclaw's own files
# to /app so that `node openclaw.mjs` resolves ./dist/entry.js correctly
# while still finding its npm dependencies in /app/node_modules/.
RUN npm install openclaw && \
    cp node_modules/openclaw/openclaw.mjs . && \
    cp -r node_modules/openclaw/dist .

# Container-specific startup optimizations
ENV NODE_ENV=production
ENV OPENCLAW_NO_RESPAWN=1
ENV OPENCLAW_DISABLE_BONJOUR=1
ENV OPENCLAW_SKIP_CANVAS_HOST=1
