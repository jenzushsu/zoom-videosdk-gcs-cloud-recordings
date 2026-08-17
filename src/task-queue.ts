import { CloudTasksClient, protos } from "@google-cloud/tasks";
import type { IngressConfig, CopyTask } from "./types.js";
import { taskIdFor } from "./events.js";

export interface TaskQueue {
  enqueue(task: CopyTask): Promise<"created" | "duplicate">;
}

const isAlreadyExists = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === 6;

export class GoogleTaskQueue implements TaskQueue {
  readonly #client: CloudTasksClient;
  readonly #config: IngressConfig;
  readonly #parent: string;

  constructor(config: IngressConfig, client: CloudTasksClient = new CloudTasksClient()) {
    this.#client = client;
    this.#config = config;
    this.#parent = client.queuePath(config.projectId, config.tasksLocation, config.tasksQueue);
  }

  async enqueue(copyTask: CopyTask): Promise<"created" | "duplicate"> {
    const taskName = `${this.#parent}/tasks/${taskIdFor(copyTask)}`;
    const task: protos.google.cloud.tasks.v2.ITask = {
      name: taskName,
      dispatchDeadline: { seconds: 1800 },
      httpRequest: {
        httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
        url: `${this.#config.workerUrl}/tasks/copy`,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(copyTask)),
        oidcToken: {
          serviceAccountEmail: this.#config.taskInvokerServiceAccount,
          audience: this.#config.workerUrl
        }
      }
    };

    try {
      await this.#client.createTask({ parent: this.#parent, task });
      return "created";
    } catch (error) {
      if (isAlreadyExists(error)) return "duplicate";
      throw error;
    }
  }
}
