import { describe, it, expect, beforeEach } from "bun:test";
import { KubeWatcher } from "./watch";
import type { WatchEvent } from "./watch";

interface FakeResource {
	metadata: { name: string; resourceVersion?: string };
	spec: { value: string };
}

const BASE_CONFIG = {
	apiUrl: "https://fake.example.com",
	token: "test-token",
};

describe("KubeWatcher", () => {
	it("can be constructed with minimal config", () => {
		const events: WatchEvent<FakeResource>[] = [];
		const watcher = new KubeWatcher<FakeResource>(BASE_CONFIG, {
			path: "/apis/boilerhouse.dev/v1alpha1/boilerhouseworkloads",
			onEvent: (e) => { events.push(e); },
		});
		expect(watcher).toBeTruthy();
	});

	it("stop() is safe to call before start()", () => {
		const watcher = new KubeWatcher<FakeResource>(BASE_CONFIG, {
			path: "/apis/boilerhouse.dev/v1alpha1/boilerhouseworkloads",
			onEvent: () => {},
		});
		expect(() => watcher.stop()).not.toThrow();
	});

	it("start() is idempotent — second call is a no-op", () => {
		// We can't easily verify the no-op without a live server, but we can
		// verify it does not throw and stop() cleans up.
		const watcher = new KubeWatcher<FakeResource>(BASE_CONFIG, {
			path: "/apis/boilerhouse.dev/v1alpha1/boilerhouseworkloads",
			onEvent: () => {},
			// Route errors to a no-op so we don't see stderr noise in tests
			onError: () => {},
		});
		watcher.start();
		watcher.start(); // second call should be silent no-op
		watcher.stop();
	});
});
