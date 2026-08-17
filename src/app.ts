import express, { type NextFunction, type Request, type Response } from "express";
import type { AppConfig, IngressConfig, WorkerConfig } from "./types.js";
import type { Logger } from "./logger.js";
import type { TaskQueue } from "./task-queue.js";
import type { RecordingStore } from "./storage.js";
import { PermanentDownloadError } from "./storage.js";
import {
  mapEventToTasks,
  parseCopyTask,
  parseJsonObject,
  parseValidationEvent,
  parseVideoSdkEvent
} from "./events.js";
import { validationResponse, verifyZoomSignature } from "./zoom-signature.js";

export interface AppDependencies {
  logger: Logger;
  taskQueue?: TaskQueue;
  recordingStore?: RecordingStore;
  now?: () => number;
}

const rawBody = (request: Request): Buffer | undefined =>
  Buffer.isBuffer(request.body) ? request.body : undefined;

const ingressRoutes = (config: IngressConfig, dependencies: AppDependencies) => {
  const router = express.Router();
  const queue = dependencies.taskQueue;
  if (!queue) throw new Error("Ingress requires a task queue");

  router.post("/webhooks/zoom", async (request, response) => {
    const body = rawBody(request);
    if (!body) return response.status(400).json({ error: "Expected an application/json body" });

    const timestamp = request.header("x-zm-request-timestamp");
    const signature = request.header("x-zm-signature");
    if (!verifyZoomSignature(config.zoomWebhookSecret, timestamp, signature, body, dependencies.now?.())) {
      dependencies.logger.warn("Rejected Zoom webhook authentication");
      return response.status(401).json({ error: "Unauthorized" });
    }

    const value = parseJsonObject(body);
    if (!value) return response.status(400).json({ error: "Malformed JSON payload" });

    if (value.event === "endpoint.url_validation") {
      const event = parseValidationEvent(value);
      if (!event) return response.status(400).json({ error: "Malformed endpoint validation payload" });
      return response
        .status(200)
        .json(validationResponse(config.zoomWebhookSecret, event.payload.plainToken));
    }

    if (typeof value.event !== "string" || !value.event.startsWith("session.recording_")) {
      dependencies.logger.debug("Ignored unsupported Zoom webhook event");
      return response.status(200).json({ accepted: true, tasks: 0 });
    }

    const event = parseVideoSdkEvent(value);
    if (!event) return response.status(400).json({ error: "Malformed or unsupported Video SDK event" });
    const tasks = mapEventToTasks(event);
    const results = await Promise.all(tasks.map((task) => queue.enqueue(task)));
    const created = results.filter((result) => result === "created").length;
    dependencies.logger.info("Accepted Video SDK artifacts", {
      event: event.event,
      sessionId: event.payload.object.session_id,
      taskCount: tasks.length,
      createdCount: created
    });
    return response.status(200).json({ accepted: true, tasks: tasks.length, created });
  });

  return router;
};

const workerRoutes = (_config: WorkerConfig, dependencies: AppDependencies) => {
  const router = express.Router();
  const store = dependencies.recordingStore;
  if (!store) throw new Error("Worker requires a recording store");

  router.post("/tasks/copy", express.json({ limit: "100kb" }), async (request, response) => {
    if (!request.header("x-cloudtasks-taskname") || !request.header("x-cloudtasks-queuename")) {
      dependencies.logger.warn("Rejected request missing Cloud Tasks headers");
      return response.status(403).json({ error: "Forbidden" });
    }

    const task = parseCopyTask(request.body);
    if (!task) return response.status(400).json({ error: "Malformed copy task" });

    try {
      const result = await store.copy(task);
      dependencies.logger.info("Recording artifact copy completed", {
        event: task.event,
        sessionId: task.sessionId,
        fileId: task.fileId,
        result
      });
      return response.status(204).send();
    } catch (error) {
      if (error instanceof PermanentDownloadError) {
        dependencies.logger.warn("Recording artifact is no longer downloadable", {
          event: task.event,
          sessionId: task.sessionId,
          fileId: task.fileId,
          status: error.status
        });
        return response.status(204).send();
      }
      throw error;
    }
  });

  return router;
};

export const createApp = (config: AppConfig, dependencies: AppDependencies) => {
  const app = express();
  app.disable("x-powered-by");

  app.get(["/health", "/healthz"], (_request, response) =>
    response.status(200).json({ status: "ok", role: config.role })
  );

  if (config.role === "ingress") {
    app.use(express.raw({ type: "application/json", limit: "1mb" }));
    app.use(ingressRoutes(config, dependencies));
  } else {
    app.use(workerRoutes(config, dependencies));
  }

  app.use((_request, response) => response.status(404).json({ error: "Not found" }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    dependencies.logger.error("Request failed", {
      errorType: error instanceof Error ? error.name : "UnknownError"
    });
    if (!response.headersSent) response.status(500).json({ error: "Internal server error" });
  });

  return app;
};
