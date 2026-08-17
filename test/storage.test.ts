import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Storage } from "@google-cloud/storage";
import { GcsRecordingStore, PermanentDownloadError } from "../src/storage.js";
import type { CopyTask } from "../src/types.js";

const task: CopyTask = {
  version: 1,
  event: "session.recording_completed",
  accountId: "account",
  sessionId: "session",
  fileId: "file",
  fileSize: 5,
  downloadUrl: "https://zoom.example/download",
  downloadToken: "token",
  objectName: "recording/file.mp4",
  contentType: "video/mp4"
};

const fakeStorage = (exists: boolean, output = new PassThrough()) => {
  output.resume();
  const file = {
    exists: vi.fn().mockResolvedValue([exists]),
    createWriteStream: vi.fn().mockReturnValue(output)
  };
  const bucket = { file: vi.fn().mockReturnValue(file) };
  const storage = { bucket: vi.fn().mockReturnValue(bucket) } as unknown as Storage;
  return { storage, file, output };
};

describe("GcsRecordingStore", () => {
  it("skips an existing object without downloading", async () => {
    const { storage } = fakeStorage(true);
    const fetchMock = vi.fn();
    const store = new GcsRecordingStore("bucket", storage, fetchMock as unknown as typeof fetch);
    expect(await store.copy(task)).toBe("existing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams a Zoom response with create-only GCS options", async () => {
    const { storage, file } = fakeStorage(false);
    const fetchMock = vi.fn().mockResolvedValue(new Response("video"));
    const store = new GcsRecordingStore("bucket", storage, fetchMock as unknown as typeof fetch);
    expect(await store.copy(task)).toBe("created");
    expect(fetchMock).toHaveBeenCalledWith(
      task.downloadUrl,
      expect.objectContaining({ headers: { authorization: "Bearer token" }, redirect: "follow" })
    );
    expect(file.createWriteStream).toHaveBeenCalledWith(
      expect.objectContaining({ preconditionOpts: { ifGenerationMatch: 0 }, validation: "crc32c" })
    );
  });

  it("classifies permanent and retryable download responses", async () => {
    const permanent = fakeStorage(false);
    const permanentStore = new GcsRecordingStore(
      "bucket",
      permanent.storage,
      vi.fn().mockResolvedValue(new Response("gone", { status: 404 })) as unknown as typeof fetch
    );
    await expect(permanentStore.copy(task)).rejects.toBeInstanceOf(PermanentDownloadError);

    const retryable = fakeStorage(false);
    const retryableStore = new GcsRecordingStore(
      "bucket",
      retryable.storage,
      vi.fn().mockResolvedValue(new Response("later", { status: 503 })) as unknown as typeof fetch
    );
    await expect(retryableStore.copy(task)).rejects.toThrow("Retryable Zoom download failure");
  });

  it("surfaces upload stream failures for Cloud Tasks retry", async () => {
    const output = new PassThrough();
    output.on("pipe", () => output.destroy(new Error("GCS unavailable")));
    const { storage } = fakeStorage(false, output);
    const store = new GcsRecordingStore(
      "bucket",
      storage,
      vi.fn().mockResolvedValue(new Response("video")) as unknown as typeof fetch
    );
    await expect(store.copy(task)).rejects.toThrow("GCS unavailable");
  });
});
