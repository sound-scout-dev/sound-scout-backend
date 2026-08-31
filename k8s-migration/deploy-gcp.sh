#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# 1. SETUP ENVIRONMENT VARIABLES
# ==============================================================================
# Replace these values with your actual GCP details
export GCP_PROJECT_ID="sound-scout-prod-001"
export GCP_REGION="asia-southeast1"
export GKE_CLUSTER_NAME="sound-scout-cluster"
export GAR_REPO_NAME="sound-scout-repo"

# Paths to the workspace directories (on your local machine)
export SOURCE_DIR="/home/hiru616/Documents/Projects/SoundScout"
export BUILD_DIR="/home/hiru616/Data/Documents/Projects/Sound Scout"

# ==============================================================================
# 2. CREATE GCP ARTIFACT REGISTRY & AUTHENTICATE DOCKER
# ==============================================================================
echo "Creating Artifact Registry..."
gcloud artifacts repositories create "$GAR_REPO_NAME" \
    --repository-format=docker \
    --location="$GCP_REGION" \
    --description="SoundScout Container Repository" \
    --project="$GCP_PROJECT_ID"

echo "Configuring docker authentication..."
gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet

# ==============================================================================
# 3. TAG AND PUSH IMAGES TO GCP ARTIFACT REGISTRY
# ==============================================================================
echo "Tagging Docker images..."
docker tag sound-scout-backend:latest "${GCP_REGION}-docker.pkg.dev/$GCP_PROJECT_ID/$GAR_REPO_NAME/sound-scout-backend:latest"
docker tag sound-scout-whatsapp-worker:latest "${GCP_REGION}-docker.pkg.dev/$GCP_PROJECT_ID/$GAR_REPO_NAME/sound-scout-whatsapp-worker:latest"
docker tag sound-scout-ai:latest "${GCP_REGION}-docker.pkg.dev/$GCP_PROJECT_ID/$GAR_REPO_NAME/sound-scout-ai:latest"

echo "Pushing images to GCP..."
docker push "${GCP_REGION}-docker.pkg.dev/$GCP_PROJECT_ID/$GAR_REPO_NAME/sound-scout-backend:latest"
docker push "${GCP_REGION}-docker.pkg.dev/$GCP_PROJECT_ID/$GAR_REPO_NAME/sound-scout-whatsapp-worker:latest"
docker push "${GCP_REGION}-docker.pkg.dev/$GCP_PROJECT_ID/$GAR_REPO_NAME/sound-scout-ai:latest"

# ==============================================================================
# 4. CONNECT KUBECTL TO GKE CLUSTER
# ==============================================================================
echo "Getting GKE credentials..."
gcloud container clusters get-credentials "$GKE_CLUSTER_NAME" \
    --region "$GCP_REGION" \
    --project "$GCP_PROJECT_ID"

# ==============================================================================
# 5. UPDATE MANIFESTS WITH GCP IMAGE URLS
# ==============================================================================
echo "Updating manifests with remote GCP image URLs..."
sed -i "s|gcr.io/sound-scout-project/sound-scout-backend:latest|${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${GAR_REPO_NAME}/sound-scout-backend:latest|g" "$SOURCE_DIR/backend/k8s-migration/manifests/backend-deployment.yaml"
sed -i "s|gcr.io/sound-scout-project/sound-scout-whatsapp-worker:latest|${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${GAR_REPO_NAME}/sound-scout-whatsapp-worker:latest|g" "$SOURCE_DIR/backend/k8s-migration/manifests/whatsapp-worker-deployment.yaml"
sed -i "s|gcr.io/sound-scout-project/sound-scout-ai:latest|${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${GAR_REPO_NAME}/sound-scout-ai:latest|g" "$SOURCE_DIR/backend/k8s-migration/manifests/ai-deployment.yaml"

# ==============================================================================
# 6. APPLY KUBERNETES MANIFESTS
# ==============================================================================
echo "Deploying to GKE..."
cd "$SOURCE_DIR/backend"
# secrets.local.yaml holds the real values and is gitignored — see manifests/README.md
kubectl apply -f k8s-migration/manifests/secrets.local.yaml
kubectl apply -f k8s-migration/manifests/configmap.yaml
kubectl apply -f k8s-migration/manifests/pvc.yaml
kubectl apply -f k8s-migration/manifests/backend-deployment.yaml
kubectl apply -f k8s-migration/manifests/whatsapp-worker-deployment.yaml
kubectl apply -f k8s-migration/manifests/ai-deployment.yaml

echo "Deployment complete! Checking pod status..."
kubectl get pods
