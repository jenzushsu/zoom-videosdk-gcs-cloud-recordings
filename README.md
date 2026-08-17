# Sample app: Zoom Video SDK recordings to Google Cloud Storage

This repository is a **sample application** that demonstrates how to archive completed Zoom Video SDK cloud-recording artifacts in a private Google Cloud Storage bucket.

> [!IMPORTANT]
> This project is provided as an implementation example, not as a production-ready or officially supported service. Review and adapt its security, reliability, observability, compliance, cost, and operational settings before using it in your own environment.

The sample verifies Zoom webhooks, creates one durable Cloud Task per downloadable artifact, and streams each file from Zoom directly into GCS. Recordings are never buffered on local disk.

## Features

- Supports `session.recording_completed`, `session.recording_transcript_completed`, and `session.recording_summary_completed`.
- Copies standard recordings plus participant audio and video files, depending on the Recording settings [enabled](https://developers.zoom.us/docs/build/cloud-recording/).
- Authenticates Zoom webhook requests and handles endpoint validation. Please refer to [Zoom Webhook](https://developers.zoom.us/docs/api/webhooks/) documentation on configuration and validation.
- Uses Cloud Tasks for durable delivery and retry handling.
- Uses Cloud Run OIDC authentication for the private worker.
- Prevents duplicate tasks and GCS overwrites with deterministic IDs and generation preconditions.
- Streams uploads with CRC32C validation and resumable GCS writes.
- Avoids logging webhook bodies, tokens, authorization headers, and download URLs.

Only artifacts with a Zoom `download_url` are copied. Bring Your Own Storage (BYOS) artifacts containing only `external_storage_url` are intentionally ignored.

## Architecture

Deploy the same image as two Cloud Run services, selected by `SERVICE_ROLE`:

```text
                         OIDC-authenticated request
Zoom ──webhook──▶ ingress ──▶ Cloud Tasks ──▶ worker ──stream──▶ GCS
                  public                       private
```

- **Ingress** verifies the raw webhook body and signature, then enqueues a copy job for each artifact.
- **Cloud Tasks** persists jobs and retries transient failures. The short-lived Zoom download token is carried in the encrypted task payload.
- **Worker** downloads each artifact and streams it into GCS without writing it to disk.
- **GCS** rejects overwrites through an `ifGenerationMatch: 0` precondition.

Task IDs and object names are deterministic, making duplicate Zoom deliveries and Cloud Tasks retries safe.

### Object layout

```text
accounts/{account_id}/sessions/{encoded_session_id}/{category}/{file_id}.{extension}
```

`category` is `recording`, `transcript`, or `summary`. Each object also stores the Zoom account ID, session ID, file ID, and source event as custom metadata.

## Requirements

- Node.js 22 or later
- A Zoom Video SDK app with cloud recording enabled
- A Google Cloud project with billing enabled
- The Google Cloud CLI for deployment
- Application Default Credentials for local Google Cloud access

## Local development

```bash
npm install
cp .env.example .env
gcloud auth application-default login
```

Set `SERVICE_ROLE=ingress` or `SERVICE_ROLE=worker` in `.env`, complete the variables for that role, and start the server:

```bash
npm run dev
curl http://localhost:3000/healthz
```

Local ingress can receive webhooks, but Cloud Tasks must still be able to reach an HTTPS worker. Production worker requests are protected by Cloud Run IAM and OIDC in addition to the application-level Cloud Tasks header checks.

### Commands

| Command                | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `npm run dev`          | Run the TypeScript server in watch mode |
| `npm run check`        | Run the complete validation suite       |
| `npm test`             | Run tests with coverage                 |
| `npm run typecheck`    | Type-check without emitting files       |
| `npm run lint`         | Run ESLint                              |
| `npm run format:check` | Check Prettier formatting               |
| `npm run format:write` | Apply Prettier formatting               |
| `npm run build`        | Compile production files to `dist/`     |
| `npm start`            | Run the compiled server                 |

Run all checks before deployment:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
docker build -t zoom-videosdk-gcs-cloud-recordings .
```

## Configuration

Shared variables:

| Variable       | Required | Default | Description                         |
| -------------- | -------- | ------- | ----------------------------------- |
| `SERVICE_ROLE` | Yes      | —       | `ingress` or `worker`               |
| `PORT`         | No       | `3000`  | HTTP listening port                 |
| `LOG_LEVEL`    | No       | `info`  | `debug`, `info`, `warn`, or `error` |

Ingress variables:

| Variable                       | Description                                                         |
| ------------------------------ | ------------------------------------------------------------------- |
| `ZOOM_WEBHOOK_SECRET_TOKEN`    | Zoom secret used for signature verification and endpoint validation |
| `GOOGLE_CLOUD_PROJECT`         | Project ID containing the task queue                                |
| `CLOUD_TASKS_LOCATION`         | Cloud Tasks queue region                                            |
| `CLOUD_TASKS_QUEUE`            | Cloud Tasks queue name                                              |
| `WORKER_URL`                   | HTTPS base URL of the private worker                                |
| `TASK_INVOKER_SERVICE_ACCOUNT` | Service account attached to task OIDC tokens                        |

Worker variables:

| Variable     | Description                             |
| ------------ | --------------------------------------- |
| `GCS_BUCKET` | Destination bucket name without `gs://` |

See [.env.example](./.env.example) for a complete template.

## Deploy to Google Cloud

The example uses `us-west1`. Replace every placeholder before running it.

### 1. Set deployment values

```bash
export PROJECT_ID="your-project-id"
export REGION="us-west1"
export BUCKET="your-globally-unique-bucket-name"
export QUEUE="zoom-recording-copies"
export REPOSITORY="zoom-recordings"
export IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/service:1.0.0"

gcloud config set project "$PROJECT_ID"
```

### 2. Create the infrastructure

```bash
gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com \
  cloudtasks.googleapis.com run.googleapis.com secretmanager.googleapis.com \
  storage.googleapis.com

gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker --location="$REGION"

gcloud storage buckets create "gs://$BUCKET" \
  --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets update "gs://$BUCKET" --public-access-prevention

gcloud tasks queues create "$QUEUE" \
  --location="$REGION" \
  --max-concurrent-dispatches=4 \
  --max-dispatches-per-second=4 \
  --max-attempts=20 \
  --max-retry-duration=72000s \
  --min-backoff=10s \
  --max-backoff=3600s \
  --max-doublings=5
```

The 20-hour retry window stays inside Zoom's 24-hour download-token lifetime.

### 3. Create identities and IAM bindings

```bash
gcloud iam service-accounts create zoom-webhook-ingress \
  --display-name="Zoom webhook ingress"
gcloud iam service-accounts create zoom-recording-worker \
  --display-name="Zoom recording worker"
gcloud iam service-accounts create zoom-tasks-invoker \
  --display-name="Zoom Cloud Tasks invoker"

export INGRESS_SA="zoom-webhook-ingress@$PROJECT_ID.iam.gserviceaccount.com"
export WORKER_SA="zoom-recording-worker@$PROJECT_ID.iam.gserviceaccount.com"
export INVOKER_SA="zoom-tasks-invoker@$PROJECT_ID.iam.gserviceaccount.com"

gcloud tasks queues add-iam-policy-binding "$QUEUE" \
  --location="$REGION" \
  --member="serviceAccount:$INGRESS_SA" \
  --role="roles/cloudtasks.enqueuer"

gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" \
  --member="serviceAccount:$INGRESS_SA" \
  --role="roles/iam.serviceAccountUser"

gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$WORKER_SA" \
  --role="roles/storage.objectCreator"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$WORKER_SA" \
  --role="roles/storage.objectViewer"
```

Viewer access lets the worker check for an existing object before it downloads the artifact.

### 4. Build and deploy the worker

```bash
gcloud builds submit --tag="$IMAGE"

gcloud run deploy zoom-videosdk-gcs-worker \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$WORKER_SA" \
  --no-allow-unauthenticated \
  --timeout=1800 \
  --concurrency=4 \
  --memory=1Gi \
  --set-env-vars="SERVICE_ROLE=worker,GCS_BUCKET=$BUCKET,LOG_LEVEL=info"

export WORKER_URL="$(gcloud run services describe zoom-videosdk-gcs-worker \
  --region="$REGION" --format='value(status.url)')"

gcloud run services add-iam-policy-binding zoom-videosdk-gcs-worker \
  --region="$REGION" \
  --member="serviceAccount:$INVOKER_SA" \
  --role="roles/run.invoker"
```

### 5. Store the Zoom secret and deploy ingress

```bash
gcloud secrets create zoom-webhook-secret --replication-policy=automatic
gcloud secrets versions add zoom-webhook-secret --data-file=-
```

The second command waits for input. Paste the Zoom webhook secret and press Ctrl-D. Then run:

```bash
gcloud secrets add-iam-policy-binding zoom-webhook-secret \
  --member="serviceAccount:$INGRESS_SA" \
  --role="roles/secretmanager.secretAccessor"

gcloud run deploy zoom-videosdk-gcs-ingress \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$INGRESS_SA" \
  --allow-unauthenticated \
  --concurrency=80 \
  --memory=512Mi \
  --set-env-vars="SERVICE_ROLE=ingress,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,CLOUD_TASKS_LOCATION=$REGION,CLOUD_TASKS_QUEUE=$QUEUE,WORKER_URL=$WORKER_URL,TASK_INVOKER_SERVICE_ACCOUNT=$INVOKER_SA,LOG_LEVEL=info" \
  --set-secrets="ZOOM_WEBHOOK_SECRET_TOKEN=zoom-webhook-secret:latest"

export INGRESS_URL="$(gcloud run services describe zoom-videosdk-gcs-ingress \
  --region="$REGION" --format='value(status.url)')"

echo "$INGRESS_URL/webhooks/zoom"
```

### 6. Configure Zoom

In the Zoom Video SDK app:

1. Register the printed `/webhooks/zoom` URL as the event notification endpoint.
2. Complete Zoom's endpoint validation flow.
3. Subscribe to the three supported recording completion events.
4. Ensure the webhook secret matches the Secret Manager value.

## Verify the deployment

Check ingress health:

```bash
curl "$INGRESS_URL/health"
```

The worker is private. The caller needs permission to invoke it:

```bash
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "$WORKER_URL/health"
```

For an end-to-end smoke test:

1. Start a Video SDK session and enable cloud recording.
2. Generate a transcript or summary where supported.
3. End the session and wait for the completion webhooks.
4. Inspect the archived objects:

   ```bash
   gcloud storage ls --recursive "gs://$BUCKET/accounts/**"
   gcloud storage objects describe "gs://$BUCKET/OBJECT_PATH" \
     --format="yaml(name,size,generation,contentType,metadata)"
   ```

5. Redeliver a webhook or retry its task. Confirm the object's generation does not change.

## Failure and retry behavior

| Condition                                         | Result                                               |
| ------------------------------------------------- | ---------------------------------------------------- |
| Duplicate webhook or task                         | The deterministic task or object is reused           |
| Object already exists                             | The task is acknowledged without overwriting it      |
| Zoom returns `408`, `429`, or `5xx`               | The worker returns `500`; Cloud Tasks retries        |
| Zoom returns another error such as `401` or `404` | The failure is treated as permanent and acknowledged |
| Download, stream, or GCS upload fails             | The worker returns `500`; Cloud Tasks retries        |
| Task payload is malformed                         | The worker returns `400`                             |

Use Cloud Run and Cloud Tasks logs to investigate failures. Logs include event, session, and file identifiers but deliberately exclude secrets and download details.

## Security and operations

- Keep the worker private and grant `roles/run.invoker` only to the task invoker service account.
- Keep the bucket private with uniform bucket-level access and public access prevention.
- Do not enable request-body logging; Cloud Task payloads contain Zoom download tokens.
- Monitor Cloud Tasks retry exhaustion. After the token expires, the original task cannot recover the download.
- Configure retention, lifecycle, versioning, replication, and CMEK separately when required.

## License

Licensed under the [ISC License](./LICENSE).
