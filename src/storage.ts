import { Storage } from "@google-cloud/storage";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { CopyTask } from "./types.js";

export class PermanentDownloadError extends Error {
  constructor(readonly status: number) {
    super(`Zoom download permanently rejected with HTTP ${status}`);
    this.name = "PermanentDownloadError";
  }
}

export interface RecordingStore {
  copy(task: CopyTask): Promise<"created" | "existing">;
}

const isPreconditionFailure = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === 412 || error.code === "412";
};

const shouldRetryDownload = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export class GcsRecordingStore implements RecordingStore {
  readonly #storage: Storage;
  readonly #bucketName: string;
  readonly #fetch: typeof fetch;

  constructor(bucketName: string, storage = new Storage(), fetchImplementation: typeof fetch = fetch) {
    this.#bucketName = bucketName;
    this.#storage = storage;
    this.#fetch = fetchImplementation;
  }

  async copy(task: CopyTask): Promise<"created" | "existing"> {
    const destination = this.#storage.bucket(this.#bucketName).file(task.objectName);
    const [exists] = await destination.exists();
    if (exists) return "existing";

    const response = await this.#fetch(task.downloadUrl, {
      headers: { authorization: `Bearer ${task.downloadToken}` },
      redirect: "follow",
      signal: AbortSignal.timeout(30 * 60 * 1000)
    });

    if (!response.ok) {
      if (shouldRetryDownload(response.status))
        throw new Error(`Retryable Zoom download failure: HTTP ${response.status}`);
      throw new PermanentDownloadError(response.status);
    }
    if (!response.body) throw new Error("Zoom download returned no response body");

    const output = destination.createWriteStream({
      resumable: true,
      chunkSize: 8 * 1024 * 1024,
      validation: "crc32c",
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType: task.contentType,
        metadata: {
          zoomAccountId: task.accountId,
          zoomSessionId: task.sessionId,
          zoomFileId: task.fileId,
          zoomEvent: task.event
        }
      }
    });

    try {
      await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), output);
      return "created";
    } catch (error) {
      if (isPreconditionFailure(error)) return "existing";
      throw error;
    }
  }
}
