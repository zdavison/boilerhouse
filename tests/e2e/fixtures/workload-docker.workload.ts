import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "e2e-docker",
	version: "1.0.0",
	image: { ref: "docker.io/library/alpine:3.21" },
	resources: { vcpus: 1, memory_mb: 128 },
	network: { access: "none" },
	idle: { timeout_seconds: 300, action: "destroy" },
	entrypoint: {
		cmd: "/bin/sh",
		args: ["-c", "while true; do sleep 1; done"],
	},
	metadata: { description: "Minimal Alpine container for Docker E2E testing" },
});
