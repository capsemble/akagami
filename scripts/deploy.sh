#!/usr/bin/env bash
# Deploy to Cloud Run from source. One-time setup lives in SETUP.md.
set -euo pipefail

SERVICE="${SERVICE:-chapter-quest}"
REGION="${REGION:-asia-southeast1}"

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --set-env-vars NODE_ENV=production
