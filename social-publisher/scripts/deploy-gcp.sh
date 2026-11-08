#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project id}"
REGION="${REGION:-europe-west1}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-eur3}"
SERVICE="${SERVICE:-social-publisher}"
REPOSITORY="${REPOSITORY:-social-publisher}"
RUNTIME_SA="${SERVICE}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:latest"

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  aiplatform.googleapis.com \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  firestore.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com

gcloud artifacts repositories describe "$REPOSITORY" \
  --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format docker \
    --location "$REGION"

gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SERVICE" \
    --display-name "Social Publisher"

for role in \
  roles/aiplatform.user \
  roles/datastore.user \
  roles/secretmanager.secretAccessor \
  roles/secretmanager.secretVersionAdder; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${RUNTIME_SA}" \
    --role "$role" \
    --quiet >/dev/null
done

gcloud firestore databases describe --database="(default)" >/dev/null 2>&1 ||
  gcloud firestore databases create \
    --database="(default)" \
    --location="$FIRESTORE_LOCATION" \
    --type=firestore-native

gcloud builds submit --tag "$IMAGE" .
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --service-account "$RUNTIME_SA" \
  --no-allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --min 0 \
  --max 3 \
  --timeout 900 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --format='value(status.url)')"
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region "$REGION" \
  --member "serviceAccount:${RUNTIME_SA}" \
  --role roles/run.invoker \
  --quiet >/dev/null

upsert_scheduler() {
  local name="$1"
  local schedule="$2"
  local path="$3"
  local deadline="$4"
  local command="create"
  if gcloud scheduler jobs describe "$name" --location "$REGION" >/dev/null 2>&1; then
    command="update"
  fi
  gcloud scheduler jobs "$command" http "$name" \
    --location "$REGION" \
    --schedule "$schedule" \
    --time-zone "Europe/Istanbul" \
    --uri "${SERVICE_URL}${path}" \
    --http-method POST \
    --headers "Content-Type=application/json" \
    --message-body "{}" \
    --oidc-service-account-email "$RUNTIME_SA" \
    --oidc-token-audience "$SERVICE_URL" \
    --attempt-deadline "$deadline"
}

upsert_scheduler "${SERVICE}-daily" "0 10 * * *" "/v1/generate-daily" "900s"
upsert_scheduler "${SERVICE}-dispatch" "*/5 * * * *" "/v1/dispatch" "300s"

echo "Deployed ${SERVICE} to ${SERVICE_URL}"
