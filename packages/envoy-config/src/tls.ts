import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TlsMaterial } from "./types";

/** Only allow valid domain characters to prevent path traversal or injection. */
function validateDomain(domain: string): void {
	if (!/^[a-zA-Z0-9.*-]+$/.test(domain)) {
		throw new Error(`Invalid domain for TLS cert generation: "${domain}"`);
	}
}

/**
 * Generate a self-signed CA and per-domain leaf certs for MITM TLS termination.
 * Uses `openssl` CLI for portability (available in all environments).
 */
export function generateTlsMaterial(domains: string[]): TlsMaterial {
	for (const d of domains) validateDomain(d);

	const dir = mkdtempSync(join(tmpdir(), "boilerhouse-tls-"));

	try {
		// Generate CA key + self-signed cert
		execFileSync("openssl", [
			"req", "-x509", "-newkey", "ec",
			"-pkeyopt", "ec_paramgen_curve:prime256v1",
			"-keyout", join(dir, "ca.key"),
			"-out", join(dir, "ca.crt"),
			"-days", "365", "-nodes",
			"-subj", "/CN=Boilerhouse Proxy CA",
			"-addext", "basicConstraints=critical,CA:TRUE",
			"-addext", "keyUsage=critical,keyCertSign,cRLSign",
		], { stdio: "pipe" });

		const caCert = readFileSync(join(dir, "ca.crt"), "utf-8");
		const caKey = readFileSync(join(dir, "ca.key"), "utf-8");

		// Generate per-domain leaf certs
		const certs = domains.map((domain) => {
			const safe = domain.replace(/[.*]/g, "_");

			// Create leaf key + CSR
			execFileSync("openssl", [
				"req", "-newkey", "ec",
				"-pkeyopt", "ec_paramgen_curve:prime256v1",
				"-keyout", join(dir, `${safe}.key`),
				"-out", join(dir, `${safe}.csr`),
				"-nodes",
				"-subj", `/CN=${domain}`,
			], { stdio: "pipe" });

			// Sign with CA — include SAN
			const extFile = join(dir, `${safe}.ext`);
			writeFileSync(extFile, `subjectAltName=DNS:${domain}\n`);

			execFileSync("openssl", [
				"x509", "-req",
				"-in", join(dir, `${safe}.csr`),
				"-CA", join(dir, "ca.crt"),
				"-CAkey", join(dir, "ca.key"),
				"-CAcreateserial",
				"-out", join(dir, `${safe}.crt`),
				"-days", "365",
				"-extfile", extFile,
			], { stdio: "pipe" });

			return {
				domain,
				cert: readFileSync(join(dir, `${safe}.crt`), "utf-8"),
				key: readFileSync(join(dir, `${safe}.key`), "utf-8"),
			};
		});

		return { caCert, caKey, certs };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
