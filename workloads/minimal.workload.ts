import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "minimal",
	version: "0.1.0",
	image: { dockerfile: "minimal/Dockerfile" },
	resources: { vcpus: 1, memory_mb: 128 },
	network: { access: "none" },
	idle: { timeout_seconds: 300, action: "hibernate" },
	metadata: { description: "Minimal Alpine VM for testing" },
});
