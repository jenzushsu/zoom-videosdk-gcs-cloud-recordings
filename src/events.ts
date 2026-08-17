import { createHash } from "node:crypto";
import type {
  CopyTask,
  EventCategory,
  RecordingFile,
  SupportedEvent,
  ValidationEvent,
  VideoSdkEvent
} from "./types.js";
import { SUPPORTED_EVENTS } from "./types.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isSupportedEvent = (value: unknown): value is SupportedEvent =>
  typeof value === "string" && SUPPORTED_EVENTS.some((event) => event === value);

export const parseJsonObject = (rawBody: Buffer): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const parseValidationEvent = (value: Record<string, unknown>): ValidationEvent | undefined => {
  if (value.event !== "endpoint.url_validation" || !isObject(value.payload)) return undefined;
  if (!isString(value.payload.plainToken) || typeof value.event_ts !== "number") return undefined;
  return value as unknown as ValidationEvent;
};

const parseRecordingFile = (value: unknown): RecordingFile | undefined => {
  if (!isObject(value) || !isString(value.id) || !isString(value.file_extension)) return undefined;
  if (value.file_size !== undefined && (typeof value.file_size !== "number" || value.file_size < 0))
    return undefined;
  return value as unknown as RecordingFile;
};

const parseFileArray = (value: unknown): RecordingFile[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parseRecordingFile);
  return parsed.every((file): file is RecordingFile => file !== undefined) ? parsed : undefined;
};

export const parseVideoSdkEvent = (value: Record<string, unknown>): VideoSdkEvent | undefined => {
  if (!isSupportedEvent(value.event)) return undefined;
  if (typeof value.event_ts !== "number" || !isString(value.download_token) || !isObject(value.payload))
    return undefined;
  const object = value.payload.object;
  if (!isString(value.payload.account_id) || !isObject(object) || !isString(object.session_id))
    return undefined;

  const recordingFiles = parseFileArray(object.recording_files);
  const participantAudioFiles = parseFileArray(object.participant_audio_files);
  const participantVideoFiles = parseFileArray(object.participant_video_files);
  if (!recordingFiles || !participantAudioFiles || !participantVideoFiles) return undefined;

  return value as unknown as VideoSdkEvent;
};

export const eventCategory = (event: SupportedEvent): EventCategory => {
  if (event === "session.recording_transcript_completed") return "transcript";
  if (event === "session.recording_summary_completed") return "summary";
  return "recording";
};

const safeSegment = (value: string): string => encodeURIComponent(value).replace(/\./g, "%2E");

const safeExtension = (extension: string): string => {
  const normalized = extension.toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(normalized) ? normalized : "bin";
};

export const objectNameFor = (
  accountId: string,
  sessionId: string,
  category: EventCategory,
  file: Pick<RecordingFile, "file_extension" | "id">
): string =>
  `accounts/${safeSegment(accountId)}/sessions/${safeSegment(sessionId)}/${category}/${safeSegment(file.id)}.${safeExtension(file.file_extension)}`;

const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  jpg: "image/jpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  txt: "text/plain; charset=utf-8",
  vtt: "text/vtt; charset=utf-8"
};

export const contentTypeFor = (extension: string): string =>
  CONTENT_TYPES[extension.toLowerCase()] ?? "application/octet-stream";

export const mapEventToTasks = (event: VideoSdkEvent): CopyTask[] => {
  const { account_id: accountId, object } = event.payload;
  const files = [
    ...(object.recording_files ?? []),
    ...(object.participant_audio_files ?? []),
    ...(object.participant_video_files ?? [])
  ];
  const category = eventCategory(event.event);
  const seen = new Set<string>();

  return files.flatMap((file): CopyTask[] => {
    if (!file.download_url || seen.has(file.id)) return [];
    seen.add(file.id);
    return [
      {
        version: 1,
        event: event.event,
        accountId,
        sessionId: object.session_id,
        fileId: file.id,
        ...(file.file_size === undefined ? {} : { fileSize: file.file_size }),
        downloadUrl: file.download_url,
        downloadToken: event.download_token,
        objectName: objectNameFor(accountId, object.session_id, category, file),
        contentType: contentTypeFor(file.file_extension)
      }
    ];
  });
};

export const taskIdFor = (task: Pick<CopyTask, "event" | "accountId" | "sessionId" | "fileId">): string =>
  `copy-${createHash("sha256")
    .update([task.event, task.accountId, task.sessionId, task.fileId].join("\0"))
    .digest("hex")}`;

export const parseCopyTask = (value: unknown): CopyTask | undefined => {
  if (!isObject(value) || value.version !== 1 || !isSupportedEvent(value.event)) return undefined;
  const requiredKeys = [
    "accountId",
    "sessionId",
    "fileId",
    "downloadUrl",
    "downloadToken",
    "objectName",
    "contentType"
  ];
  if (!requiredKeys.every((key) => isString(value[key]))) return undefined;
  if (value.fileSize !== undefined && (typeof value.fileSize !== "number" || value.fileSize < 0))
    return undefined;
  try {
    const url = new URL(value.downloadUrl as string);
    if (url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return value as unknown as CopyTask;
};
