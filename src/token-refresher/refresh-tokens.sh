#!/bin/bash
set -uo pipefail

echo "=========================================="
echo "Token Refresh Started: $(date)"
echo "=========================================="

# ============================================
# ATLASSIAN TOKEN REFRESH
# ============================================
echo ""
echo "=== Refreshing Atlassian Tokens ==="

ATLASSIAN_CLIENT_ID=$(kubectl get secret atlassian-mcp-secrets -n librechat -o jsonpath='{.data.ATLASSIAN_CLIENT_ID}' | base64 -d)
ATLASSIAN_CLIENT_SECRET=$(kubectl get secret atlassian-mcp-secrets -n librechat -o jsonpath='{.data.ATLASSIAN_CLIENT_SECRET}' | base64 -d)
ATLASSIAN_REFRESH_TOKEN=$(kubectl get secret atlassian-mcp-secrets -n librechat -o jsonpath='{.data.ATLASSIAN_REFRESH_TOKEN}' | base64 -d)

ATLASSIAN_RESPONSE=$(curl -s -X POST https://auth.atlassian.com/oauth/token \
  -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"refresh_token\",\"client_id\":\"$ATLASSIAN_CLIENT_ID\",\"client_secret\":\"$ATLASSIAN_CLIENT_SECRET\",\"refresh_token\":\"$ATLASSIAN_REFRESH_TOKEN\"}")

ATLASSIAN_ACCESS=$(echo "$ATLASSIAN_RESPONSE" | jq -r '.access_token')
ATLASSIAN_NEW_REFRESH=$(echo "$ATLASSIAN_RESPONSE" | jq -r '.refresh_token')

if [ "$ATLASSIAN_ACCESS" = "null" ] || [ -z "$ATLASSIAN_ACCESS" ]; then
  echo "ERROR refreshing Atlassian tokens:"
  echo "$ATLASSIAN_RESPONSE" | jq
  ATLASSIAN_SUCCESS=false
else
  echo "Successfully refreshed Atlassian tokens"
  kubectl patch secret atlassian-mcp-secrets -n librechat --type='merge' -p="{\"data\":{\"ATLASSIAN_CONFLUENCE_TOKEN\":\"$(echo -n "$ATLASSIAN_ACCESS" | base64 -w 0)\",\"ATLASSIAN_JIRA_TOKEN\":\"$(echo -n "$ATLASSIAN_ACCESS" | base64 -w 0)\",\"ATLASSIAN_REFRESH_TOKEN\":\"$(echo -n "$ATLASSIAN_NEW_REFRESH" | base64 -w 0)\"}}"
  ATLASSIAN_SUCCESS=true
fi

# ============================================
# MICROSOFT TOKEN REFRESH
# ============================================
echo ""
echo "=== Refreshing Microsoft Tokens ==="

MS_CLIENT_ID=$(kubectl get secret microsoft-mcp-secrets -n librechat -o jsonpath='{.data.MICROSOFT_CLIENT_ID}' | base64 -d)
MS_CLIENT_SECRET=$(kubectl get secret microsoft-mcp-secrets -n librechat -o jsonpath='{.data.MICROSOFT_CLIENT_SECRET}' | base64 -d)
MS_TENANT_ID=$(kubectl get secret microsoft-mcp-secrets -n librechat -o jsonpath='{.data.MICROSOFT_TENANT_ID}' | base64 -d)
MS_REFRESH_TOKEN=$(kubectl get secret microsoft-mcp-secrets -n librechat -o jsonpath='{.data.MICROSOFT_REFRESH_TOKEN}' | base64 -d)

echo "Tenant: $MS_TENANT_ID"

MS_RESPONSE=$(curl -s -X POST "https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=${MS_CLIENT_ID}" \
  --data-urlencode "scope=Files.Read.All Sites.Read.All User.Read offline_access" \
  --data-urlencode "refresh_token=${MS_REFRESH_TOKEN}" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "client_secret=${MS_CLIENT_SECRET}")

MS_ACCESS=$(echo "$MS_RESPONSE" | jq -r '.access_token')
MS_NEW_REFRESH=$(echo "$MS_RESPONSE" | jq -r '.refresh_token')

if [ "$MS_ACCESS" = "null" ] || [ -z "$MS_ACCESS" ]; then
  echo "ERROR refreshing Microsoft tokens:"
  echo "$MS_RESPONSE" | jq
  MICROSOFT_SUCCESS=false
else
  echo "Successfully refreshed Microsoft tokens"
  kubectl patch secret microsoft-mcp-secrets -n librechat --type='merge' -p="{\"data\":{\"MICROSOFT_ACCESS_TOKEN\":\"$(echo -n "$MS_ACCESS" | base64 -w 0)\",\"MICROSOFT_REFRESH_TOKEN\":\"$(echo -n "$MS_NEW_REFRESH" | base64 -w 0)\"}}"
  MICROSOFT_SUCCESS=true
fi

# ============================================
# BOX TOKEN REFRESH
# ============================================
echo ""
echo "=== Refreshing Box Tokens ==="

BOX_CLIENT_ID=$(kubectl get secret box-mcp-secrets -n librechat -o jsonpath='{.data.BOX_CLIENT_ID}' | base64 -d)
BOX_CLIENT_SECRET=$(kubectl get secret box-mcp-secrets -n librechat -o jsonpath='{.data.BOX_CLIENT_SECRET}' | base64 -d)
BOX_REFRESH_TOKEN=$(kubectl get secret box-mcp-secrets -n librechat -o jsonpath='{.data.BOX_REFRESH_TOKEN}' | base64 -d)

BOX_RESPONSE=$(curl -s -X POST "https://api.box.com/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=${BOX_CLIENT_ID}" \
  --data-urlencode "client_secret=${BOX_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${BOX_REFRESH_TOKEN}" \
  --data-urlencode "grant_type=refresh_token")

BOX_ACCESS=$(echo "$BOX_RESPONSE" | jq -r '.access_token')
BOX_NEW_REFRESH=$(echo "$BOX_RESPONSE" | jq -r '.refresh_token')

if [ "$BOX_ACCESS" = "null" ] || [ -z "$BOX_ACCESS" ]; then
  echo "ERROR refreshing Box tokens:"
  echo "$BOX_RESPONSE" | jq
  BOX_SUCCESS=false
else
  echo "Successfully refreshed Box tokens"
  kubectl patch secret box-mcp-secrets -n librechat --type='merge' -p="{\"data\":{\"BOX_ACCESS_TOKEN\":\"$(echo -n "$BOX_ACCESS" | base64 -w 0)\",\"BOX_REFRESH_TOKEN\":\"$(echo -n "$BOX_NEW_REFRESH" | base64 -w 0)\"}}"
  BOX_SUCCESS=true
fi

# ============================================
# RESTART SERVICES TO PICK UP NEW TOKENS
# ============================================
echo ""
echo "=== Restarting Proxy Services ==="

if [ "$ATLASSIAN_SUCCESS" = "true" ] || [ "$MICROSOFT_SUCCESS" = "true" ] || [ "$BOX_SUCCESS" = "true" ]; then
  kubectl rollout restart deployment gemini-search-proxy -n librechat
  kubectl rollout restart deployment openai-search-proxy -n librechat
  echo "Restarted search proxy deployments"
fi

echo ""
echo "=========================================="
echo "Token Refresh Completed: $(date)"
echo "Atlassian: ${ATLASSIAN_SUCCESS:-false}"
echo "Microsoft: ${MICROSOFT_SUCCESS:-false}"
echo "Box: ${BOX_SUCCESS:-false}"
echo "=========================================="
