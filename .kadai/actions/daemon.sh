#!/bin/bash
# kadai:name Check Docker
# kadai:emoji 🐳
# kadai:description Verify the Docker daemon is running and accessible

set -euo pipefail

if ! command -v docker &>/dev/null; then
  echo "Error: docker not found. Install Docker: https://docs.docker.com/get-docker/" >&2
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "Error: Docker daemon is not running or not accessible." >&2
  echo "Hint: Start Docker Desktop or run: sudo systemctl start docker" >&2
  exit 1
fi

echo "✓ Docker daemon is running"
docker version --format 'Client: {{.Client.Version}}  Server: {{.Server.Version}}'
