import { describe, it, expect } from "bun:test";
import { FINALIZER, addFinalizer, removeFinalizer } from "./status";

describe("FINALIZER", () => {
	it("is the expected constant", () => {
		expect(FINALIZER).toBe("boilerhouse.dev/cleanup");
	});
});

describe("addFinalizer", () => {
	it("adds a finalizer to metadata with no existing finalizers", () => {
		const meta = { name: "test" };
		const result = addFinalizer(meta, FINALIZER);
		expect(result.finalizers).toEqual([FINALIZER]);
	});

	it("adds a finalizer to metadata with existing finalizers", () => {
		const meta = { name: "test", finalizers: ["other.io/cleanup"] };
		const result = addFinalizer(meta, FINALIZER);
		expect(result.finalizers).toEqual(["other.io/cleanup", FINALIZER]);
	});

	it("is idempotent — does not duplicate an existing finalizer", () => {
		const meta = { name: "test", finalizers: [FINALIZER] };
		const result = addFinalizer(meta, FINALIZER);
		expect(result.finalizers).toEqual([FINALIZER]);
		// Should return the exact same object (no copy made)
		expect(result).toBe(meta);
	});

	it("does not mutate the input metadata", () => {
		const meta = { name: "test", finalizers: ["other.io/cleanup"] };
		const original = { ...meta, finalizers: [...meta.finalizers] };
		addFinalizer(meta, FINALIZER);
		expect(meta.finalizers).toEqual(original.finalizers);
	});

	it("preserves all other metadata fields", () => {
		const meta = { name: "test", namespace: "default", labels: { app: "foo" } };
		const result = addFinalizer(meta, FINALIZER);
		expect(result.name).toBe("test");
		expect(result.namespace).toBe("default");
		expect(result.labels).toEqual({ app: "foo" });
	});
});

describe("removeFinalizer", () => {
	it("removes an existing finalizer", () => {
		const meta = { name: "test", finalizers: [FINALIZER] };
		const result = removeFinalizer(meta, FINALIZER);
		expect(result.finalizers).toEqual([]);
	});

	it("removes only the specified finalizer, leaving others intact", () => {
		const meta = { name: "test", finalizers: ["other.io/cleanup", FINALIZER] };
		const result = removeFinalizer(meta, FINALIZER);
		expect(result.finalizers).toEqual(["other.io/cleanup"]);
	});

	it("is idempotent — no-op when finalizer is not present", () => {
		const meta = { name: "test", finalizers: ["other.io/cleanup"] };
		const result = removeFinalizer(meta, FINALIZER);
		expect(result.finalizers).toEqual(["other.io/cleanup"]);
		// Should return the exact same object (no copy made)
		expect(result).toBe(meta);
	});

	it("is idempotent — no-op when finalizers is undefined", () => {
		const meta = { name: "test" };
		const result = removeFinalizer(meta, FINALIZER);
		expect(result).toBe(meta);
	});

	it("does not mutate the input metadata", () => {
		const meta = { name: "test", finalizers: [FINALIZER, "other.io/cleanup"] };
		const original = [...meta.finalizers];
		removeFinalizer(meta, FINALIZER);
		expect(meta.finalizers).toEqual(original);
	});

	it("preserves all other metadata fields", () => {
		const meta = { name: "test", namespace: "default", finalizers: [FINALIZER] };
		const result = removeFinalizer(meta, FINALIZER);
		expect(result.name).toBe("test");
		expect(result.namespace).toBe("default");
	});
});

describe("addFinalizer + removeFinalizer roundtrip", () => {
	it("adding then removing leaves original state", () => {
		const meta = { name: "test", finalizers: ["other.io/cleanup"] };
		const added = addFinalizer(meta, FINALIZER);
		const removed = removeFinalizer(added, FINALIZER);
		expect(removed.finalizers).toEqual(["other.io/cleanup"]);
	});
});
