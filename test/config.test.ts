import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads role-specific ingress configuration", () => {
    const config = loadConfig({
      SERVICE_ROLE: "ingress",
      ZOOM_WEBHOOK_SECRET_TOKEN: "secret",
      GOOGLE_CLOUD_PROJECT: "project",
      CLOUD_TASKS_LOCATION: "asia-southeast1",
      CLOUD_TASKS_QUEUE: "queue",
      WORKER_URL: "https://worker.example/",
      TASK_INVOKER_SERVICE_ACCOUNT: "invoker@example.iam.gserviceaccount.com"
    });
    expect(config).toMatchObject({ role: "ingress", port: 3000, workerUrl: "https://worker.example" });
  });

  it("loads role-specific worker configuration", () => {
    expect(loadConfig({ SERVICE_ROLE: "worker", PORT: "8080", GCS_BUCKET: "recordings" })).toMatchObject({
      role: "worker",
      port: 8080,
      gcsBucket: "recordings"
    });
  });

  it.each([
    [{}, "SERVICE_ROLE"],
    [{ SERVICE_ROLE: "other" }, "SERVICE_ROLE"],
    [{ SERVICE_ROLE: "worker" }, "GCS_BUCKET"],
    [{ SERVICE_ROLE: "worker", GCS_BUCKET: "bucket", PORT: "zero" }, "PORT"]
  ])("rejects invalid configuration", (environment, message) => {
    expect(() => loadConfig(environment)).toThrow(message);
  });
});
