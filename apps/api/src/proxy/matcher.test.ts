import { describe, test, expect } from "bun:test";
import { matchesDomain } from "./matcher";

describe("matchesDomain", () => {
	test("exact match returns true", () => {
		expect(matchesDomain("example.com", ["example.com"])).toBe(true);
	});

	test("exact non-match returns false", () => {
		expect(matchesDomain("other.com", ["example.com"])).toBe(false);
	});

	test("wildcard matches single-level subdomain", () => {
		expect(matchesDomain("sub.example.com", ["*.example.com"])).toBe(true);
	});

	test("wildcard matches multi-level subdomain", () => {
		expect(
			matchesDomain("a.b.example.com", ["*.example.com"]),
		).toBe(true);
	});

	test("wildcard does not match bare domain", () => {
		expect(matchesDomain("example.com", ["*.example.com"])).toBe(false);
	});

	test("wildcard does not match unrelated domain", () => {
		expect(matchesDomain("evil.com", ["*.example.com"])).toBe(false);
	});

	test("empty allowlist returns false", () => {
		expect(matchesDomain("example.com", [])).toBe(false);
	});

	test("case insensitive matching", () => {
		expect(matchesDomain("Example.COM", ["example.com"])).toBe(true);
		expect(matchesDomain("sub.EXAMPLE.com", ["*.example.com"])).toBe(true);
	});

	test("multiple entries — matches any", () => {
		expect(
			matchesDomain("api.github.com", ["example.com", "*.github.com"]),
		).toBe(true);
	});

	test("multiple entries — matches none", () => {
		expect(
			matchesDomain("evil.com", ["example.com", "*.github.com"]),
		).toBe(false);
	});
});
