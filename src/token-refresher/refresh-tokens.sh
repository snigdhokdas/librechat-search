#!/bin/bash
set -euo pipefail

# Configuration
VAULT_PATH="/var/secrets"
LOG_FILE="/var/log/token-refresh.log"
TEMP_DIR="/tmp/token-refresh"

# Logging function
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

# Create temp directory
mkdir -p "$TEMP_DIR"

log "Starting token refresh process..."

# Read current secrets
CLIENT_ID=$(cat "$VAULT_PATH/ATLASSIAN_CLIENT_ID" | base64 -d)
CLIENT_SECRET=$(cat "$VAULT_PATH/ATLASSIAN_CLIENT_SECRET" | base64 -d) 
DOMAIN=$(cat "$VAULT_PATH/ATLASSIAN_DOMAIN" | base64 -d)

# Get current tokens (these are base64 encoded JWTs)
CURRENT_CONFLUENCE_TOKEN=$(cat "$VAULT_PATH/ATLASSIAN_CONFLUENCE_TOKEN" | base64 -d)
CURRENT_JIRA_TOKEN=$(cat "$VAULT_PATH/ATLASSIAN_JIRA_TOKEN" | base64 -d)

# Function to extract refresh token from JWT
extract_refresh_token() {
    local jwt_token="$1"
    local service_name="$2"
    
    log "Extracting refresh token for $service_name..."
    
    # Decode the JWT payload (second part after splitting by .)
    local payload=$(echo "$jwt_token" | cut -d'.' -f2)
    # Add padding if needed for base64 decoding
    local padded_payload="${payload}$(printf '%*s' $(((4 - ${#payload} % 4) % 4)) '' | tr ' ' '=')"
    
    # Decode and extract refresh_token field
    local refresh_token=$(echo "$padded_payload" | base64 -d 2>/dev/null | jq -r '.refresh_token // empty')
    
    if [[ -z "$refresh_token" || "$refresh_token" == "null" ]]; then
        log "ERROR: Could not extract refresh token from $service_name JWT"
        return 1
    fi
    
    echo "$refresh_token"
}

# Function to refresh access token using refresh token
refresh_access_token() {
    local refresh_token="$1"
    local service_name="$2"
    
    log "Refreshing access token for $service_name..."
    
    local response=$(curl -s -X POST "https://auth.atlassian.com/oauth/token" \
        -H "Content-Type: application/json" \
        -d "{
            \"grant_type\": \"refresh_token\",
            \"client_id\": \"$CLIENT_ID\",
            \"client_secret\": \"$CLIENT_SECRET\",
            \"refresh_token\": \"$refresh_token\"
        }")
    
    # Check if response contains error
    if echo "$response" | jq -e '.error' > /dev/null; then
        local error_msg=$(echo "$response" | jq -r '.error_description // .error')
        log "ERROR: Token refresh failed for $service_name: $error_msg"
        return 1
    fi
    
    # Extract new access token
    local new_access_token=$(echo "$response" | jq -r '.access_token')
    local new_refresh_token=$(echo "$response" | jq -r '.refresh_token')
    
    if [[ -z "$new_access_token" || "$new_access_token" == "null" ]]; then
        log "ERROR: No access token received for $service_name"
        return 1
    fi
    
    log "Successfully refreshed access token for $service_name"
    echo "$new_access_token"
}

# Function to update Kubernetes secret
update_secret() {
    local secret_key="$1"
    local new_token="$2"
    local service_name="$3"
    
    log "Updating Kubernetes secret for $service_name..."
    
    # Base64 encode the new token
    local encoded_token=$(echo -n "$new_token" | base64 -w 0)
    
    # Create patch JSON
    local patch_json="{\"data\":{\"$secret_key\":\"$encoded_token\"}}"
    
    # Apply the patch
    if kubectl patch secret atlassian-mcp-secrets -n librechat --type='merge' -p "$patch_json"; then
        log "Successfully updated Kubernetes secret for $service_name"
    else
        log "ERROR: Failed to update Kubernetes secret for $service_name"
        return 1
    fi
}

# Function to restart deployment to pick up new tokens
restart_deployment() {
    log "Restarting atlassian-mcp-proxy deployment to pick up new tokens..."
    
    if kubectl rollout restart deployment/atlassian-mcp-proxy -n librechat; then
        log "Successfully triggered deployment restart"
        
        # Wait for rollout to complete
        if kubectl rollout status deployment/atlassian-mcp-proxy -n librechat --timeout=300s; then
            log "Deployment restart completed successfully"
        else
            log "WARNING: Deployment restart timed out, but may still be in progress"
        fi
    else
        log "ERROR: Failed to restart deployment"
        return 1
    fi
}

# Main refresh logic
main() {
    local success_count=0
    local total_count=2
    
    # Refresh Confluence token
    if CONFLUENCE_REFRESH=$(extract_refresh_token "$CURRENT_CONFLUENCE_TOKEN" "Confluence"); then
        if NEW_CONFLUENCE_TOKEN=$(refresh_access_token "$CONFLUENCE_REFRESH" "Confluence"); then
            if update_secret "ATLASSIAN_CONFLUENCE_TOKEN" "$NEW_CONFLUENCE_TOKEN" "Confluence"; then
                success_count=$((success_count + 1))
            fi
        fi
    fi
    
    # Refresh JIRA token  
    if JIRA_REFRESH=$(extract_refresh_token "$CURRENT_JIRA_TOKEN" "JIRA"); then
        if NEW_JIRA_TOKEN=$(refresh_access_token "$JIRA_REFRESH" "JIRA"); then
            if update_secret "ATLASSIAN_JIRA_TOKEN" "$NEW_JIRA_TOKEN" "JIRA"; then
                success_count=$((success_count + 1))
            fi
        fi
    fi
    
    # Restart deployment if at least one token was refreshed successfully
    if [[ $success_count -gt 0 ]]; then
        restart_deployment
        log "Token refresh completed successfully ($success_count/$total_count tokens refreshed)"
    else
        log "ERROR: No tokens were refreshed successfully"
        return 1
    fi
    
    # Cleanup
    rm -rf "$TEMP_DIR"
    log "Token refresh process completed"
}

# Execute main function
main
