#!/bin/bash
# kadai:name Minikube
# kadai:emoji ☸️
# kadai:description Start/stop the minikube test cluster for K8s runtime tests

set -euo pipefail

PROFILE="boilerhouse-test"
NAMESPACE="boilerhouse"

# ── Install minikube + kubectl if missing ─────────────────────────────────

install_minikube() {
  echo "minikube not found — installing..."
  case "$(uname -s)" in
    Darwin)
      if command -v brew &>/dev/null; then
        brew install minikube
      else
        echo "Error: Homebrew not found. Install minikube manually." >&2
        exit 1
      fi
      ;;
    Linux)
      curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
      sudo install minikube-linux-amd64 /usr/local/bin/minikube
      rm minikube-linux-amd64
      ;;
  esac
}

install_kubectl() {
  echo "kubectl not found — installing..."
  case "$(uname -s)" in
    Darwin)
      if command -v brew &>/dev/null; then
        brew install kubectl
      else
        echo "Error: Homebrew not found. Install kubectl manually." >&2
        exit 1
      fi
      ;;
    Linux)
      curl -LO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
      sudo install kubectl /usr/local/bin/kubectl
      rm kubectl
      ;;
  esac
}

command -v minikube &>/dev/null || install_minikube
command -v kubectl &>/dev/null || install_kubectl

# ── Cluster lifecycle ─────────────────────────────────────────────────────

# If cluster is already running, offer status and exit
if minikube status -p "$PROFILE" &>/dev/null; then
  echo "Cluster '$PROFILE' is already running."
  echo "  API server: $(minikube ip -p "$PROFILE"):8443"
  echo ""
  echo "To stop:   minikube stop -p $PROFILE"
  echo "To delete: minikube delete -p $PROFILE"
  exit 0
fi

echo "Starting minikube cluster '$PROFILE'..."
minikube start -p "$PROFILE" \
  --driver=docker \
  --cpus=2 \
  --memory=2048

# ── Namespace + RBAC ──────────────────────────────────────────────────────

kubectl --context="$PROFILE" get namespace "$NAMESPACE" &>/dev/null \
  || kubectl --context="$PROFILE" create namespace "$NAMESPACE"

kubectl --context="$PROFILE" -n "$NAMESPACE" apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: boilerhouse-runtime
  namespace: boilerhouse
rules:
  - apiGroups: [""]
    resources: [pods, pods/exec, pods/log, services, configmaps]
    verbs: [get, list, create, delete, watch]
  - apiGroups: ["networking.k8s.io"]
    resources: [networkpolicies]
    verbs: [get, list, create, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: boilerhouse-runtime
  namespace: boilerhouse
subjects:
  - kind: ServiceAccount
    name: default
    namespace: boilerhouse
roleRef:
  kind: Role
  name: boilerhouse-runtime
  apiGroup: rbac.authorization.k8s.io
EOF

# ── Pre-pull Envoy image for sidecar proxy tests ────────────────────────

echo "Pulling Envoy image into minikube..."
minikube -p "$PROFILE" image pull docker.io/envoyproxy/envoy:v1.32-latest

echo ""
echo "Minikube ready: profile=$PROFILE namespace=$NAMESPACE"
echo "  API server: $(minikube ip -p "$PROFILE"):8443"
echo "  Token:      kubectl --context=$PROFILE -n $NAMESPACE create token default"
