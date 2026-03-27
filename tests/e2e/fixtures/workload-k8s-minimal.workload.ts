import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "e2e-minimal",
	version: "1.0.0",
	image: { ref: "docker.io/library/alpine:3.21" },
	resources: { vcpus: 1, memory_mb: 128, disk_gb: 1 },
	network: { access: "none" },
	idle: { timeout_seconds: 300, action: "hibernate" },
	entrypoint: {
		cmd: "/bin/sh",
		args: ["-c", "while true; do sleep 1; done"],
	},
	metadata: { description: "Minimal Alpine container for K8s E2E testing" },
});
