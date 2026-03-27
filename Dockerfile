FROM oven/bun:1.3.9-alpine AS build

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun build --compile --target=bun-linux-x64 apps/cli/src/main.ts --outfile boilerhouse

FROM gcr.io/distroless/base-nossl-debian12

COPY --from=build /app/boilerhouse /boilerhouse

EXPOSE 3000 9464

ENV RUNTIME_TYPE=kubernetes
ENV LISTEN_HOST=0.0.0.0
ENV PORT=3000

ENTRYPOINT ["/boilerhouse"]
CMD ["api", "start"]
