#!/bin/bash
set -euo pipefail

AWS_ACCOUNT=281355808288
REGION=us-east-1
REPO=librechat-token-refresher
TAG=$(date +%Y%m%d-%H%M%S)
FULL_REPO="$AWS_ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO"

echo "Building $REPO:$TAG"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$AWS_ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

docker build -t "$REPO:$TAG" -t "$REPO:latest" src/token-refresher/
docker tag "$REPO:$TAG" "$FULL_REPO:$TAG"
docker tag "$REPO:latest" "$FULL_REPO:latest"
docker push "$FULL_REPO:$TAG"
docker push "$FULL_REPO:latest"

echo "Pushed $FULL_REPO:$TAG"
echo "Pushed $FULL_REPO:latest"
