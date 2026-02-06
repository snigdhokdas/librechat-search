# LibreChat Search

AI-powered enterprise document search across Confluence, SharePoint, and Box. Built on [LibreChat](https://github.com/danny-avila/LibreChat) with custom search proxy services that integrate with Gemini and OpenAI models.

## What It Does

Users interact through a familiar chat interface at `librechat.rynotrax.com`. When they ask a question, the system:
1. Searches relevant document sources (Confluence, SharePoint, Box)
2. Ranks and merges results using fuzzy matching
3. Sends results + question to an AI model (Gemini or OpenAI)
4. Returns a comprehensive answer with source citations and links

Eight search endpoints are available (4 sources x 2 AI providers):
- Confluence + Gemini/OpenAI
- SharePoint + Gemini/OpenAI
- Box + Gemini/OpenAI
- Unified (all sources) + Gemini/OpenAI

## Architecture

```
User -> LibreChat UI -> Search Proxy -> [Source APIs] -> AI Model -> Response
                     -> Analytics Service -> MongoDB (tracking)
                                          -> Redis (caching)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed service topology and request flow.

## Prerequisites

- AWS EKS cluster
- AWS ECR access (account: 281355808288, us-east-1)
- `kubectl` configured for the cluster
- Docker for building images
- Helm 3 for MongoDB/Redis

## Quick Start

### 1. Build and push images

```bash
# All images at once
bash build/build-all.sh

# Or individually
bash build/gemini-search-proxy.sh
bash build/openai-search-proxy.sh
bash build/analytics-service.sh
bash build/analytics-dashboard.sh
bash build/token-refresher.sh
```

### 2. Deploy infrastructure (if not already running)

```bash
# MongoDB
helm install mongodb oci://registry-1.docker.io/bitnamicharts/mongodb \
  -n librechat -f helm/mongodb-values.yaml

# Redis
helm install redis oci://registry-1.docker.io/bitnamicharts/redis \
  -n librechat -f helm/redis-values.yaml
```

### 3. Apply K8s manifests

```bash
# Namespace (if new)
kubectl apply -f k8s/namespace.yaml

# Secrets (create from templates - fill in real values first)
# kubectl apply -f k8s/secrets/

# Deployments + Services
kubectl apply -f k8s/deployments/
kubectl apply -f k8s/services/

# Config + Ingress + CronJob
kubectl apply -f k8s/configmaps/
kubectl apply -f k8s/ingresses/
kubectl apply -f k8s/cronjobs/
```

### 4. Verify

```bash
# Check all pods are running
kubectl get pods -n librechat

# Test proxy health
kubectl exec -it deploy/gemini-search-proxy -n librechat -- wget -qO- http://localhost:3000/health
kubectl exec -it deploy/openai-search-proxy -n librechat -- wget -qO- http://localhost:3001/health
```

## Project Structure

```
librechat-search/
├── src/
│   ├── gemini-search-proxy/    # Gemini AI search proxy (4 sources via path routing)
│   ├── openai-search-proxy/    # OpenAI search proxy (4 sources via path routing)
│   ├── analytics-service/      # Query tracking + caching (MongoDB + Redis)
│   ├── analytics-dashboard/    # Web dashboard (nginx)
│   └── token-refresher/        # Atlassian OAuth token refresh (CronJob)
├── k8s/
│   ├── deployments/            # Deployment manifests
│   ├── services/               # Service manifests
│   ├── configmaps/             # LibreChat endpoint configuration
│   ├── secrets/                # Secret templates (no real values)
│   ├── ingresses/              # Ingress for librechat.rynotrax.com
│   └── cronjobs/               # Token refresh CronJob
├── build/                      # ECR build/push scripts
└── helm/                       # Reference Helm values for MongoDB/Redis
```

## Environment Variables

### Search Proxies (both Gemini and OpenAI)

| Variable | Source | Description |
|---|---|---|
| `GOOGLE_API_KEY` | librechat-secrets | Gemini API key (gemini-proxy only) |
| `OPENAI_API_KEY` | librechat-secrets | OpenAI API key (openai-proxy only) |
| `ATLASSIAN_CONFLUENCE_TOKEN` | atlassian-mcp-secrets | Confluence API token |
| `ATLASSIAN_CLOUD_ID` | atlassian-mcp-secrets | Atlassian Cloud ID |
| `ATLASSIAN_DOMAIN` | atlassian-mcp-secrets | Atlassian domain |
| `MICROSOFT_ACCESS_TOKEN` | microsoft-mcp-secrets | Microsoft Graph API token |
| `BOX_ACCESS_TOKEN` | box-mcp-secrets | Box API token |

### Analytics Service

| Variable | Source | Description |
|---|---|---|
| `MONGO_URI` | librechat-secrets | MongoDB connection string |
| `REDIS_PASSWORD` | librechat-secrets | Redis password (URI constructed at runtime) |
