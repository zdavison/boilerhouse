import { createLogger } from "@boilerhouse/o11y";
import { startOperator, configFromEnv } from "./bootstrap";

const log = createLogger("operator");

log.info("boilerhouse-operator starting");

try {
  const config = configFromEnv();
  await startOperator(config);
} catch (err) {
  log.error({ err }, "operator fatal error");
  process.exit(1);
}
