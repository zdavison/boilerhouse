import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "e2e-docker-broken",
	version: "1.0.0",
	image: { ref: "docker.io/library/nonexistent-image:99.99.99" },
	resources: { vcpus: 1, memory_mb: 128 },
	network: { access: "none" },
	idle: { action: "destroy" },
	entrypoint: {
		cmd: "/bin/sh",
		args: ["-c", "exit 1"],
	},
});
