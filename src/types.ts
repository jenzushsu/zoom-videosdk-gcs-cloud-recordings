export const SUPPORTED_EVENTS = [
  "session.recording_completed",
  "session.recording_transcript_completed",
  "session.recording_summary_completed"
] as const;

export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];
export type EventCategory = "recording" | "transcript" | "summary";

export interface RecordingFile {
  id: string;
  file_size?: number;
  file_extension: string;
  download_url?: string;
  external_storage_url?: string;
  file_name?: string;
  file_type?: string;
  recording_type?: string;
}

export interface VideoSdkEvent {
  event: SupportedEvent;
  event_ts: number;
  download_token: string;
  payload: {
    account_id: string;
    object: {
      session_id: string;
      recording_files?: RecordingFile[];
      participant_audio_files?: RecordingFile[];
      participant_video_files?: RecordingFile[];
    };
  };
}

export interface ValidationEvent {
  event: "endpoint.url_validation";
  event_ts: number;
  payload: { plainToken: string };
}

export interface CopyTask {
  version: 1;
  event: SupportedEvent;
  accountId: string;
  sessionId: string;
  fileId: string;
  fileSize?: number;
  downloadUrl: string;
  downloadToken: string;
  objectName: string;
  contentType: string;
}

export interface SharedConfig {
  role: "ingress" | "worker";
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface IngressConfig extends SharedConfig {
  role: "ingress";
  zoomWebhookSecret: string;
  projectId: string;
  tasksLocation: string;
  tasksQueue: string;
  workerUrl: string;
  taskInvokerServiceAccount: string;
}

export interface WorkerConfig extends SharedConfig {
  role: "worker";
  gcsBucket: string;
}

export type AppConfig = IngressConfig | WorkerConfig;
