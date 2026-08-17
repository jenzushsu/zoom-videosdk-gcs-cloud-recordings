import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { GcsRecordingStore } from "./storage.js";
import { GoogleTaskQueue } from "./task-queue.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const dependencies =
  config.role === "ingress"
    ? { logger, taskQueue: new GoogleTaskQueue(config) }
    : { logger, recordingStore: new GcsRecordingStore(config.gcsBucket) };
const app = createApp(config, dependencies);
const server = createServer(app);

server.listen(config.port, () => logger.info("Service started", { role: config.role, port: config.port }));

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Graceful shutdown started", { signal });
  server.close((error) => {
    if (error) {
      logger.error("Graceful shutdown failed", { errorType: error.name });
      process.exitCode = 1;
    }
  });
  server.closeIdleConnections();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
