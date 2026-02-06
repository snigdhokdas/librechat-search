# Architecture

## Service Topology

```
                         ┌─────────────────────┐
                         │  librechat.rynotrax  │
                         │     .com (Ingress)   │
                         └──────┬──────┬────────┘
                                │      │
                    /analytics  │      │  /*
                                │      │
               ┌────────────────┘      └────────────────┐
               ▼                                        ▼
    ┌─────────────────────┐                  ┌─────────────────┐
    │ analytics-dashboard │                  │    librechat     │
    │   (nginx:80)        │                  │   (upstream)     │
    │                     │                  │   port 3080      │
    └─────────────────────┘                  └────────┬────────┘
                                                      │
                              ┌────────────────┬──────┴──────┐
                              ▼                ▼              ▼
                   ┌──────────────────┐ ┌──────────────────┐
                   │ gemini-search-   │ │ openai-search-   │
                   │ proxy :3000      │ │ proxy :3001      │
                   │                  │ │                  │
                   │ /confluence/*    │ │ /confluence/*    │
                   │ /sharepoint/*    │ │ /sharepoint/*    │
                   │ /box/*           │ │ /box/*           │
                   │ /unified/*       │ │ /unified/*       │
                   └────────┬─────────┘ └────────┬─────────┘
                            │                    │
                    ┌───────┼───────┐    ┌───────┼───────┐
                    ▼       ▼       ▼    ▼       ▼       ▼
              Confluence SharePoint Box  Confluence SharePoint Box
              (Atlassian)(Microsoft)(Box)(Atlassian)(Microsoft)(Box)
              API        Graph API  API  API        Graph API  API
                    │       │       │    │       │       │
                    ▼       ▼       ▼    ▼       ▼       ▼
                  Gemini API           OpenAI API
                            │                    │
                            └────────┬───────────┘
                                     ▼
                          ┌──────────────────┐
                          │ analytics-service │
                          │     :3008        │
                          └────────┬─────────┘
                                   │
                          ┌────────┴────────┐
                          ▼                 ▼
                    ┌───────────┐    ┌──────────┐
                    │  MongoDB  │    │  Redis   │
                    │  (Helm)   │    │  (Helm)  │
                    │  :27017   │    │  :6379   │
                    └───────────┘    └──────────┘
```

## Request Flow

### Search Query

1. User types question in LibreChat UI
2. LibreChat sends `POST /{source}/chat/completions` to search proxy
3. Proxy extracts user query from messages
4. Proxy checks Redis cache (via analytics-service)
5. If cache hit: return cached response
6. If cache miss:
   a. Search source API(s) - Confluence, SharePoint, Box, or all three
   b. Rank results by fuzzy relevance scoring
   c. Format results as context
   d. Send context + question to AI (Gemini or OpenAI)
   e. Cache response in Redis (24h TTL)
   f. Track query in MongoDB
7. Return response in OpenAI-compatible chat completion format

### Token Refresh

1. CronJob runs every 50 minutes
2. Reads current JWT tokens from K8s secret
3. Extracts refresh token from JWT payload
4. Calls Atlassian OAuth endpoint for new access token
5. Patches K8s secret with new token
6. Restarts proxy deployments to pick up new tokens

## Consolidation

8 separate proxy services consolidated to 2:

| Before | After |
|---|---|
| atlassian-mcp-proxy (Gemini+Confluence) | gemini-search-proxy /confluence |
| sharepoint-gemini-proxy (Gemini+SP) | gemini-search-proxy /sharepoint |
| box-gemini-proxy (Gemini+Box) | gemini-search-proxy /box |
| unified-search-proxy (Gemini+All) | gemini-search-proxy /unified |
| openai-atlassian-proxy (OpenAI+Confluence) | openai-search-proxy /confluence |
| openai-sharepoint-proxy (OpenAI+SP) | openai-search-proxy /sharepoint |
| box-openai-proxy (OpenAI+Box) | openai-search-proxy /box |
| unified-search-openai-proxy (OpenAI+All) | openai-search-proxy /unified |

## Infrastructure

| Component | Type | Image |
|---|---|---|
| gemini-search-proxy | Deployment | ECR (custom) |
| openai-search-proxy | Deployment | ECR (custom) |
| analytics-service | Deployment | ECR (custom) |
| analytics-dashboard | Deployment | ECR (custom) |
| token-refresher | CronJob | ECR (custom) |
| librechat | Deployment | Docker Hub (upstream) |
| mongodb | StatefulSet | Helm (Bitnami) |
| redis | StatefulSet | Helm (Bitnami) |
| meilisearch | Deployment | Docker Hub (upstream) |
