import type { SupportedEvent } from "../src/types.js";

export const videoEvent = (event: SupportedEvent = "session.recording_completed") => ({
  event,
  event_ts: 1_700_000_000_000,
  download_token: "short-lived-token",
  payload: {
    account_id: "account/one",
    object: {
      session_id: "session/one==",
      recording_files: [
        {
          id: "main.file",
          file_size: 10,
          file_extension: event.endsWith("summary_completed") ? "JSON" : "MP4",
          download_url: "https://zoom.example/main"
        },
        {
          id: "byos-only",
          file_extension: "MP4",
          external_storage_url: "https://s3.example/byos"
        }
      ],
      participant_audio_files: [
        {
          id: "audio",
          file_extension: "M4A",
          download_url: "https://zoom.example/audio"
        }
      ],
      participant_video_files: [
        {
          id: "video",
          file_extension: "MP4",
          download_url: "https://zoom.example/video"
        }
      ]
    }
  }
});
