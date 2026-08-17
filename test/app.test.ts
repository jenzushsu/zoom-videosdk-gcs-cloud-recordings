import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { zoomSignature } from "../src/zoom-signature.js";
import type { CopyTask, IngressConfig, WorkerConfig } from "../src/types.js";
import type { Logger } from "../src/logger.js";
import type { RecordingStore } from "../src/storage.js";
import { PermanentDownloadError } from "../src/storage.js";
import type { TaskQueue } from "../src/task-queue.js";
import { videoEvent } from "./fixtures.js";

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const ingressConfig: IngressConfig = {
  role: "ingress",
  port: 3000,
  logLevel: "info",
  zoomWebhookSecret: "secret",
  projectId: "project",
  tasksLocation: "location",
  tasksQueue: "queue",
  workerUrl: "https://worker.example",
  taskInvokerServiceAccount: "invoker@example.iam.gserviceaccount.com"
};
const workerConfig: WorkerConfig = {
  role: "worker",
  port: 3000,
  logLevel: "info",
  gcsBucket: "bucket"
};
const now = 1_700_000_000_000;
const timestamp = "1700000000";

const signedPost = (app: ReturnType<typeof createApp>, body: object | string) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return request(app)
    .post("/webhooks/zoom")
    .set("content-type", "application/json")
    .set("x-zm-request-timestamp", timestamp)
    .set("x-zm-signature", zoomSignature(ingressConfig.zoomWebhookSecret, timestamp, Buffer.from(raw)))
    .send(raw);
};

describe("ingress app", () => {
  it("reports ingress health", async () => {
    const app = createApp(ingressConfig, { logger: logger(), taskQueue: { enqueue: vi.fn() } });
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", role: "ingress" });
  });

  it("validates the webhook endpoint", async () => {
    const enqueue = vi.fn();
    const taskQueue: TaskQueue = { enqueue };
    const app = createApp(ingressConfig, { logger: logger(), taskQueue, now: () => now });
    const response = await signedPost(app, {
      event: "endpoint.url_validation",
      event_ts: now,
      payload: { plainToken: "plain" }
    });
    expect(response.status).toBe(200);
    expect(response.body.plainToken).toBe("plain");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues every downloadable artifact", async () => {
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce("created")
      .mockResolvedValueOnce("duplicate")
      .mockResolvedValueOnce("created");
    const app = createApp(ingressConfig, { logger: logger(), taskQueue: { enqueue }, now: () => now });
    const response = await signedPost(app, videoEvent());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: true, tasks: 3, created: 2 });
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid signatures and malformed supported events", async () => {
    const app = createApp(ingressConfig, {
      logger: logger(),
      taskQueue: { enqueue: vi.fn() },
      now: () => now
    });
    expect(
      (await request(app).post("/webhooks/zoom").set("content-type", "application/json").send("{}")).status
    ).toBe(401);
    expect((await signedPost(app, { event: "session.recording_completed" })).status).toBe(400);
  });

  it("acknowledges unrelated events without tasks", async () => {
    const enqueue = vi.fn();
    const app = createApp(ingressConfig, { logger: logger(), taskQueue: { enqueue }, now: () => now });
    const response = await signedPost(app, { event: "session.started", event_ts: now, payload: {} });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toEqual({ accepted: true, tasks: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

const copyTask: CopyTask = {
  version: 1,
  event: "session.recording_completed",
  accountId: "account",
  sessionId: "session",
  fileId: "file",
  downloadUrl: "https://zoom.example/download",
  downloadToken: "secret-token",
  objectName: "accounts/account/sessions/session/recording/file.mp4",
  contentType: "video/mp4"
};

describe("worker app", () => {
  const headers = { "x-cloudtasks-taskname": "task", "x-cloudtasks-queuename": "queue" };

  it("reports worker health", async () => {
    const app = createApp(workerConfig, { logger: logger(), recordingStore: { copy: vi.fn() } });
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", role: "worker" });
  });

  it("requires Cloud Tasks delivery headers", async () => {
    const copy = vi.fn();
    const recordingStore: RecordingStore = { copy };
    const app = createApp(workerConfig, { logger: logger(), recordingStore });
    expect((await request(app).post("/tasks/copy").send(copyTask)).status).toBe(403);
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies a valid task", async () => {
    const copy = vi.fn().mockResolvedValue("created");
    const app = createApp(workerConfig, { logger: logger(), recordingStore: { copy } });
    expect((await request(app).post("/tasks/copy").set(headers).send(copyTask)).status).toBe(204);
    expect(copy).toHaveBeenCalledWith(copyTask);
  });

  it("does not retry permanent download failures", async () => {
    const log = logger();
    const copy = vi.fn().mockRejectedValue(new PermanentDownloadError(404));
    const app = createApp(workerConfig, { logger: log, recordingStore: { copy } });
    const response = await request(app).post("/tasks/copy").set(headers).send(copyTask);
    expect(response.status).toBe(204);
    expect(JSON.stringify((log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("secret-token");
  });

  it("returns a retryable error without exposing secrets", async () => {
    const log = logger();
    const copy = vi.fn().mockRejectedValue(new Error("stream failed"));
    const app = createApp(workerConfig, { logger: log, recordingStore: { copy } });
    const response = await request(app).post("/tasks/copy").set(headers).send(copyTask);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(log)).not.toContain("secret-token");
  });
});
