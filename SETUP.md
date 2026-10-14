# One-time Google Cloud setup

Run these yourself — nothing in this repo runs `gcloud` for you except
`npm run deploy`, which only deploys.

Set these once per shell:

```bash
export PROJECT_ID="your-project-id"
export REGION="asia-southeast1"
gcloud config set project "$PROJECT_ID"
```

## 1. Enable the APIs

```bash
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

Argon (`DESIGN_MODEL`) needs a billing-enabled project — it has no free tier.

## 2. Create the API key secret

Get the key from AI Studio, then:

```bash
printf '%s' 'YOUR_GEMINI_API_KEY' | \
  gcloud secrets create gemini-api-key --data-file=- --replication-policy=automatic

# later rotations:
printf '%s' 'NEW_KEY' | gcloud secrets versions add gemini-api-key --data-file=-
```

## 3. Let Cloud Run read it

```bash
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

# The runtime service account (default compute SA unless you made a dedicated one).
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor

# Cloud Build needs to push the image Cloud Run runs.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/cloudbuild.builds.builder
```

## 4. Deploy

```bash
npm run deploy
```

which is:

```bash
gcloud run deploy chapter-quest \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --set-env-vars "NODE_ENV=production,DESIGN_MODEL=gemini-4-argon,TEXT_MODEL=gemini-3.8-flash,FAST_MODEL=gemini-3.5-flash-lite,IMAGE_MODEL=gemini-nano-banana-2.1,EMBED_MODEL=gemini-embedding-2"
```

Check it: `curl https://<service-url>/api/health`

## 5. Optional — deploy on push to main

`.github/workflows/deploy.yml` is ready; it needs Workload Identity Federation
so GitHub can act as a service account without a JSON key.

```bash
# a service account for deploys
gcloud iam service-accounts create gh-deployer --display-name="GitHub deployer"
DEPLOY_SA="gh-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

for ROLE in roles/run.admin roles/cloudbuild.builds.editor \
            roles/artifactregistry.admin roles/storage.admin \
            roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" --role="$ROLE"
done

# the identity pool GitHub authenticates into
gcloud iam workload-identity-pools create github --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='YOUR_GH_USER/chapter-quest'"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
POOL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL}/attribute.repository/YOUR_GH_USER/chapter-quest"

echo "WIF_PROVIDER=${POOL}/providers/github-provider"
echo "DEPLOY_SA=${DEPLOY_SA}"
```

Put those last two values in the repo's **Settings → Secrets and variables →
Actions → Variables** as `WIF_PROVIDER` and `DEPLOY_SA`.

## Local `.env`

```bash
cp .env.example .env   # then paste your key
npm run smoke          # text + image + embedding, one real call each
```

`.env` is git-ignored. The key is only ever read server-side.
