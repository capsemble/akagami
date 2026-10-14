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
  --set-env-vars "NODE_ENV=production,DESIGN_MODEL=${DESIGN_MODEL:-gemini-4-argon},TEXT_MODEL=${TEXT_MODEL:-gemini-3.8-flash},FAST_MODEL=${FAST_MODEL:-gemini-3.5-flash-lite},IMAGE_MODEL=${IMAGE_MODEL:-gemini-nano-banana-2.1},EMBED_MODEL=${EMBED_MODEL:-gemini-embedding-2}"
