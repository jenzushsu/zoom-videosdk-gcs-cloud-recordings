import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  mapEventToTasks,
  objectNameFor,
  parseCopyTask,
  parseJsonObject,
  parseVideoSdkEvent,
  taskIdFor
} from "../src/events.js";
import type { SupportedEvent } from "../src/types.js";
import { videoEvent } from "./fixtures.js";

describe("Video SDK event mapping", () => {
  it.each([
    ["session.recording_completed", "recording"],
    ["session.recording_transcript_completed", "transcript"],
    ["session.recording_summary_completed", "summary"]
  ] as const)("maps %s and all file collections", (event, category) => {
    const parsed = parseVideoSdkEvent(videoEvent(event));
    expect(parsed).toBeDefined();
    const tasks = mapEventToTasks(parsed!);
    expect(tasks).toHaveLength(3);
    expect(tasks.map((task) => task.fileId)).toEqual(["main.file", "audio", "video"]);
    expect(tasks[0]?.objectName).toBe(
      `accounts/account%2Fone/sessions/session%2Fone%3D%3D/${category}/main%2Efile.${event.endsWith("summary_completed") ? "json" : "mp4"}`
    );
    expect(JSON.stringify(tasks)).not.toContain("s3.example");
  });

  it("creates safe paths and fallback metadata", () => {
    expect(objectNameFor("../account", "a/b", "recording", { id: "../id", file_extension: "bad/ext" })).toBe(
      "accounts/%2E%2E%2Faccount/sessions/a%2Fb/recording/%2E%2E%2Fid.bin"
    );
    expect(contentTypeFor("VTT")).toContain("text/vtt");
  });

  it("creates stable, event-specific task IDs", () => {
    const base = { accountId: "a", sessionId: "s", fileId: "f" };
    const first = taskIdFor({ ...base, event: "session.recording_completed" });
    expect(first).toMatch(/^copy-[a-f0-9]{64}$/);
    expect(first).toBe(taskIdFor({ ...base, event: "session.recording_completed" }));
    expect(first).not.toBe(taskIdFor({ ...base, event: "session.recording_summary_completed" }));
  });

  it("rejects malformed events and tasks", () => {
    expect(parseJsonObject(Buffer.from("not-json"))).toBeUndefined();
    expect(parseVideoSdkEvent({ event: "session.recording_completed" })).toBeUndefined();
    expect(
      parseCopyTask({ version: 1, event: "session.recording_completed" as SupportedEvent })
    ).toBeUndefined();
  });
});
