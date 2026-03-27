#!/bin/bash
# kadai:name Security Tests
# kadai:emoji 🔴
# kadai:description Run Nuclei security templates against the API (red-team pentest)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

# Check nuclei is installed, offer to install if missing
if ! command -v nuclei &>/dev/null; then
  echo "nuclei is not installed."
  echo ""
  read -rp "Install via brew? [Y/n] " answer
  case "${answer:-Y}" in
    [Yy]*)
      brew install nuclei
      echo ""
      ;;
    *)
      echo "Aborted. Install manually with: brew install nuclei"
      exit 1
      ;;
  esac
fi

echo "Running security tests..."
exec bun run "$SCRIPT_DIR/tests/security/run-security-tests.ts"
