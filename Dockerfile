FROM oven/bun:1-alpine

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./

# Copy all workspace packages and the API app
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY workloads/ workloads/
COPY tests/package.json tests/

RUN bun install --frozen-lockfile --production

EXPOSE 3000 9464

ENV RUNTIME_TYPE=kubernetes
ENV LISTEN_HOST=0.0.0.0
ENV PORT=3000

CMD ["bun", "apps/api/src/server.ts"]
