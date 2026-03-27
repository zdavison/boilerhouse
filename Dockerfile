FROM oven/bun:1.3.9-debian AS build

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun build --compile apps/cli/src/main.ts --outfile boilerhouse

FROM gcr.io/distroless/base-nossl-debian12

COPY --from=build /app/boilerhouse /boilerhouse

EXPOSE 3000 9464

ENV RUNTIME_TYPE=docker
ENV LISTEN_HOST=0.0.0.0
ENV PORT=3000

ENTRYPOINT ["/boilerhouse"]
CMD ["api", "start"]
