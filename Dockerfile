FROM oven/bun:1.3.9-debian AS build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN bun install
RUN NODE_ENV=production bun build --compile apps/cli/src/main.ts --outfile boilerhouse

FROM gcr.io/distroless/base-nossl-debian12

COPY --from=build /app/boilerhouse /boilerhouse
COPY --from=build /app/packages/db/drizzle /drizzle

# @boilerhouse/core + deps so dynamically-imported workload files can resolve it
COPY --from=build /app/packages/core /workloads/node_modules/@boilerhouse/core
COPY --from=build /app/node_modules/@sinclair /workloads/node_modules/@sinclair
COPY --from=build /app/node_modules/age-encryption /workloads/node_modules/age-encryption

EXPOSE 3000 9464

ENV NODE_ENV=production
ENV MIGRATIONS_DIR=/drizzle
ENV RUNTIME_TYPE=docker
ENV LISTEN_HOST=0.0.0.0
ENV PORT=3000

ENTRYPOINT ["/boilerhouse"]
CMD ["api", "start"]
