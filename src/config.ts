import type { AppConfig, SharedConfig } from "./types.js";

type Environment = Record<string, string | undefined>;

const required = (env: Environment, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};

export const loadConfig = (env: Environment = process.env): AppConfig => {
  const role = required(env, "SERVICE_ROLE");
  if (role !== "ingress" && role !== "worker") {
    throw new Error("SERVICE_ROLE must be either ingress or worker");
  }

  const rawPort = env.PORT ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535");

  const rawLogLevel = env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(rawLogLevel)) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }

  const shared: SharedConfig = {
    role,
    port,
    logLevel: rawLogLevel as SharedConfig["logLevel"]
  };

  if (role === "worker") {
    return { ...shared, role, gcsBucket: required(env, "GCS_BUCKET") };
  }

  const workerUrl = required(env, "WORKER_URL").replace(/\/$/, "");
  try {
    const parsed = new URL(workerUrl);
    if (parsed.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("WORKER_URL must be a valid HTTPS URL");
  }

  return {
    ...shared,
    role,
    zoomWebhookSecret: required(env, "ZOOM_WEBHOOK_SECRET_TOKEN"),
    projectId: required(env, "GOOGLE_CLOUD_PROJECT"),
    tasksLocation: required(env, "CLOUD_TASKS_LOCATION"),
    tasksQueue: required(env, "CLOUD_TASKS_QUEUE"),
    workerUrl,
    taskInvokerServiceAccount: required(env, "TASK_INVOKER_SERVICE_ACCOUNT")
  };
};
