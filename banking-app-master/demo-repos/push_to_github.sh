#!/usr/bin/env bash
# push_to_github.sh
# ─────────────────────────────────────────────────────────────────────────────
# Creates GitHub repos in GITHUB_ORG and pushes the local git history.
#
# Prerequisites:
#   export GITHUB_ORG=oscorpAI
#   export GITHUB_PAT=ghp_...
#   bash setup_git_history.sh   (run this first)
#
# Usage: bash push_to_github.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${GITHUB_ORG:?Set GITHUB_ORG env var}"
: "${GITHUB_PAT:?Set GITHUB_PAT env var}"

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"

# Python demo repos (inside demo-repos/)
DEMO_REPOS=("payment-service" "order-service" "notification-service")

# Java Spring Boot repos (siblings of demo-repos/ in banking-app-master/)
JAVA_REPOS=("pricing-service" "order-service")
# Note: order-service appears in both lists (Python mock + Java real).
# The Java one is pushed as "pricing-service" and "order-service-java" to avoid collision,
# unless you intentionally want the Java repo to replace the Python one.
# Adjust JAVA_REPO_NAMES if needed:
JAVA_REPO_NAMES=("pricing-service" "order-service-java")
JAVA_REPO_DIRS=("../pricing-service" "../order-service")

create_and_push() {
    local repo="$1"
    local dir="$2"
    echo ""
    echo "=== $repo (dir: $dir) ==="

    # Create repo via GitHub API (ignore error if already exists)
    HTTP_STATUS=$(curl -s -o /tmp/gh_create_out.json -w "%{http_code}" \
        -X POST \
        -H "Authorization: Bearer $GITHUB_PAT" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/orgs/$GITHUB_ORG/repos" \
        -d "{\"name\":\"$repo\",\"private\":true,\"auto_init\":false}")

    if [ "$HTTP_STATUS" == "201" ]; then
        echo "  Created: https://github.com/$GITHUB_ORG/$repo"
    elif [ "$HTTP_STATUS" == "422" ]; then
        echo "  Repo already exists — skipping create"
    else
        echo "  Warning: unexpected status $HTTP_STATUS"
        cat /tmp/gh_create_out.json
    fi

    # Push
    cd "$dir"
    git remote remove origin 2>/dev/null || true
    git remote add origin "https://$GITHUB_PAT@github.com/$GITHUB_ORG/$repo.git"
    git push -u origin main --force
    echo "  Pushed: https://github.com/$GITHUB_ORG/$repo"
    cd - >/dev/null
}

echo ""
echo "── Pushing Python demo repos ──────────────────────────"
for repo in "${DEMO_REPOS[@]}"; do
    create_and_push "$repo" "$DEMO_DIR/$repo"
done

echo ""
echo "── Pushing Java Spring Boot repos ─────────────────────"
for i in "${!JAVA_REPO_NAMES[@]}"; do
    create_and_push "${JAVA_REPO_NAMES[$i]}" "$DEMO_DIR/${JAVA_REPO_DIRS[$i]}"
done

echo ""
echo "========================================================"
echo "All repos pushed to github.com/$GITHUB_ORG"
echo ""
echo "Now run:"
echo "  python demo_seed_data.py --org $GITHUB_ORG"
echo "  python demo_seed_data.py --org $GITHUB_ORG --scenario cross-service"
echo "========================================================"
