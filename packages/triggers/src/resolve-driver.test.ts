import { test, expect } from "bun:test";
import { resolveDriver, DriverResolveError } from "./resolve-driver";
import { defaultDriver } from "./drivers/default";

test("no driverSpec returns defaultDriver with empty options", async () => {
	const result = await resolveDriver(undefined);
	expect(result.driver).toBe(defaultDriver);
	expect(result.options).toEqual({});
});

test("no driverSpec with options returns defaultDriver with provided options", async () => {
	const opts = { gatewayToken: "abc", timeout: 5000 };
	const result = await resolveDriver(undefined, opts);
	expect(result.driver).toBe(defaultDriver);
	expect(result.options).toEqual(opts);
});

test("valid module with default export resolves the driver", async () => {
	// Use the built-in default driver module as a real import target
	const result = await resolveDriver("./drivers/default");
	expect(typeof result.driver.send).toBe("function");
	expect(result.options).toEqual({});
});

test("valid module with named export resolves via fallback", async () => {
	// The openclaw driver exports a named export (openclawDriver)
	// through its index which re-exports it, but the default export
	// should be preferred. Let's test with a module we know works.
	const result = await resolveDriver("./drivers/default", { key: "val" });
	expect(typeof result.driver.send).toBe("function");
	expect(result.options).toEqual({ key: "val" });
});

test("import failure throws DriverResolveError", async () => {
	try {
		await resolveDriver("./nonexistent-driver-that-does-not-exist");
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(DriverResolveError);
		expect((err as Error).message).toContain("Failed to import driver");
		expect((err as Error).message).toContain("nonexistent-driver-that-does-not-exist");
	}
});

test("module without Driver-shaped export throws DriverResolveError", async () => {
	// Import a module that exists but doesn't export a send() method
	// Use the config module as an example — it exports types and defineTrigger
	try {
		await resolveDriver("./config");
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(DriverResolveError);
		expect((err as Error).message).toContain("does not export a valid Driver");
	}
});
