import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "e2e-fake-minimal",
	version: "1.0.0",
	image: { ref: "fake:latest" },
	resources: { vcpus: 1, memory_mb: 128 },
	network: { access: "none" },
	idle: { action: "hibernate" },
});
