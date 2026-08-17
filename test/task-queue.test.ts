import type { CloudTasksClient } from "@google-cloud/tasks";
import { describe, expect, it, vi } from "vitest";
import { GoogleTaskQueue } from "../src/task-queue.js";
import type { CopyTask, IngressConfig } from "../src/types.js";

const config: IngressConfig = {
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

const task: CopyTask = {
  version: 1,
  event: "session.recording_completed",
  accountId: "account",
  sessionId: "session",
  fileId: "file",
  downloadUrl: "https://zoom.example/download",
  downloadToken: "token",
  objectName: "accounts/account/sessions/session/recording/file.mp4",
  contentType: "video/mp4"
};

const fakeClient = (createTask: ReturnType<typeof vi.fn>) =>
  ({
    queuePath: vi.fn().mockReturnValue("projects/project/locations/location/queues/queue"),
    createTask
  }) as unknown as CloudTasksClient;

describe("GoogleTaskQueue", () => {
  it("creates deterministic OIDC-authenticated HTTP tasks", async () => {
    const createTask = vi.fn().mockResolvedValue([{}]);
    const queue = new GoogleTaskQueue(config, fakeClient(createTask));
    expect(await queue.enqueue(task)).toBe("created");
    expect(createTask).toHaveBeenCalledWith({
      parent: "projects/project/locations/location/queues/queue",
      task: expect.objectContaining({
        name: expect.stringMatching(/\/tasks\/copy-[a-f0-9]{64}$/),
        httpRequest: expect.objectContaining({
          url: "https://worker.example/tasks/copy",
          oidcToken: {
            serviceAccountEmail: config.taskInvokerServiceAccount,
            audience: config.workerUrl
          }
        })
      })
    });
    const request = createTask.mock.calls[0]?.[0] as { task: { httpRequest: { body: Uint8Array } } };
    expect(JSON.parse(Buffer.from(request.task.httpRequest.body).toString("utf8"))).toEqual(task);
  });

  it("treats an existing deterministic task as a duplicate", async () => {
    const createTask = vi.fn().mockRejectedValue({ code: 6 });
    const queue = new GoogleTaskQueue(config, fakeClient(createTask));
    expect(await queue.enqueue(task)).toBe("duplicate");
  });

  it("surfaces queue failures", async () => {
    const createTask = vi.fn().mockRejectedValue(new Error("unavailable"));
    const queue = new GoogleTaskQueue(config, fakeClient(createTask));
    await expect(queue.enqueue(task)).rejects.toThrow("unavailable");
  });
});
