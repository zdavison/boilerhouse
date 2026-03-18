FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Rewrite git+ssh URLs to HTTPS so npm can fetch without SSH keys
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Install openclaw and its dependencies, then promote openclaw's own files
# to /app so that `node openclaw.mjs` resolves ./dist/entry.js correctly
# while still finding its npm dependencies in /app/node_modules/.
# The package.json must have "type": "module" so Node resolves ESM imports
# in the dist files correctly (openclaw publishes ESM-only dist).
RUN npm install openclaw@2026.3.13 && \
    cp node_modules/openclaw/openclaw.mjs . && \
    cp -r node_modules/openclaw/dist . && \
    npm pkg set type=module

# Container-specific startup optimizations
ENV NODE_ENV=production
ENV OPENCLAW_NO_RESPAWN=1
ENV OPENCLAW_DISABLE_BONJOUR=1
ENV OPENCLAW_SKIP_CANVAS_HOST=1
