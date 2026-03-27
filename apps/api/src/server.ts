import { createLogger } from "@boilerhouse/o11y";
import { bootstrap, configFromEnv } from "./bootstrap";

const log = createLogger("server");
const config = configFromEnv();
const { app } = await bootstrap(config);

app.listen({ port: config.port, hostname: config.listenHost });

log.info({ port: config.port, host: config.listenHost }, "♨️ Boilerhouse API listening");
log.info({ metricsPort: config.metricsPort }, "Prometheus metrics endpoint started");
