import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { FirecrackerClient } from "./client";
import { FirecrackerApiError } from "./errors";
import type {
	BootSourceRequest,
	MachineConfigRequest,
	DriveRequest,
	NetworkInterfaceRequest,
	ActionRequest,
	VmUpdateRequest,
	SnapshotCreateRequest,
	SnapshotLoadRequest,
	InstanceInfoResponse,
} from "./types";

interface RecordedRequest {
	method: string;
	path: string;
	body: unknown;
}

/**
 * Creates a mock Firecracker server on a Unix socket that records requests
 * and returns configurable responses.
 */
function createMockServer(socketPath: string) {
	const recorded: RecordedRequest[] = [];
	let nextResponse: { status: number; body: unknown } = {
		status: 204,
		body: null,
	};

	const server = Bun.serve({
		unix: socketPath,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.body ? await req.json() : null;
			recorded.push({
				method: req.method,
				path: url.pathname,
				body,
			});

			const { status, body: responseBody } = nextResponse;
			// Reset to default after each response
			nextResponse = { status: 204, body: null };

			if (responseBody !== null) {
				return new Response(JSON.stringify(responseBody), {
					status,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(null, { status });
		},
	});

	return {
		server,
		recorded,
		setResponse(status: number, body: unknown = null) {
			nextResponse = { status, body };
		},
		lastRequest(): RecordedRequest | undefined {
			return recorded[recorded.length - 1];
		},
	};
}

describe("FirecrackerClient", () => {
	let tmpDir: string;
	let socketPath: string;
	let mock: ReturnType<typeof createMockServer>;
	let client: FirecrackerClient;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fc-client-test-"));
		socketPath = join(tmpDir, "firecracker.sock");
		mock = createMockServer(socketPath);
		client = new FirecrackerClient(socketPath);
	});

	afterAll(() => {
		mock.server.stop(true);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("serializes PUT /boot-source request correctly", async () => {
		const body: BootSourceRequest = {
			kernel_image_path: "/path/to/vmlinux",
			boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
		};
		await client.putBootSource(body);

		const req = mock.lastRequest();
		expect(req).toBeDefined();
		expect(req!.method).toBe("PUT");
		expect(req!.path).toBe("/boot-source");
		expect(req!.body).toEqual(body);
	});

	test("serializes PUT /machine-config request correctly", async () => {
		const body: MachineConfigRequest = {
			vcpu_count: 2,
			mem_size_mib: 256,
			smt: false,
			cpu_template: "T2",
			track_dirty_pages: true,
		};
		await client.putMachineConfig(body);

		const req = mock.lastRequest();
		expect(req).toBeDefined();
		expect(req!.method).toBe("PUT");
		expect(req!.path).toBe("/machine-config");
		expect(req!.body).toEqual(body);
	});

	test("serializes PUT /drives/:id request correctly", async () => {
		const body: DriveRequest = {
			drive_id: "rootfs",
			path_on_host: "/path/to/rootfs.ext4",
			is_root_device: true,
			is_read_only: false,
		};
		await client.putDrive("rootfs", body);

		const req = mock.lastRequest();
		expect(req).toBeDefined();
		expect(req!.method).toBe("PUT");
		expect(req!.path).toBe("/drives/rootfs");
		expect(req!.body).toEqual(body);
	});

	test("serializes PUT /network-interfaces/:id request correctly", async () => {
		const body: NetworkInterfaceRequest = {
			iface_id: "eth0",
			host_dev_name: "tap-abcd1234",
			guest_mac: "02:ab:cd:12:34:56",
		};
		await client.putNetworkInterface("eth0", body);

		const req = mock.lastRequest();
		expect(req).toBeDefined();
		expect(req!.method).toBe("PUT");
		expect(req!.path).toBe("/network-interfaces/eth0");
		expect(req!.body).toEqual(body);
	});

	test("serializes PUT /actions { InstanceStart } correctly", async () => {
		const body: ActionRequest = { action_type: "InstanceStart" };
		await client.putAction(body);

		const req = mock.lastRequest();
		expect(req).toBeDefined();
		expect(req!.method).toBe("PUT");
		expect(req!.path).toBe("/actions");
		expect(req!.body).toEqual(body);
	});

	test("serializes PATCH /vm { Paused | Resumed } correctly", async () => {
		const pauseBody: VmUpdateRequest = { state: "Paused" };
		await client.patchVm(pauseBody);

		let req = mock.lastRequest();
		expect(req).toBeDefined();
		expect(req!.method).toBe("PATCH");
		expect(req!.path).toBe("/vm");
		expect(req!.body).toEqual(pauseBody);

		const resumeBody: VmUpdateRequest = { state: "Resumed" };
		await client.patchVm(resumeBody);

		req = mock.lastRequest();
		expect(req!.body).toEqual(resumeBody);
	});

	test("serializes PUT /snapshot/create request correctly", async () => {
		const body: SnapshotCreateRequest = {
			snapshot_type: "Full",
			snapshot_path: "/path/to/snapshot",
			mem_file_path: "/path/to/mem",
		};
		await client.putSnapshotCreate(body);

		const req = mock.lastRequest();
		expect(req).toBeDefined();
		expect(req!.method).toBe("PUT");
		expect(req!.path).toBe("/snapshot/create");
		expect(req!.body).toEqual(body);
	});

	test("serializes PUT /snapshot/load request correctly", async () => {
		const body: SnapshotLoadRequest = {
			snapshot_path: "/path/to/snapshot",
			mem_file_path: "/path/to/mem",
			resume_vm: true,
		};
		await client.putSnapshotLoad(body);

		const req = mock.lastRequest();
		expect(req).toBeDefined();
		expect(req!.method).toBe("PUT");
		expect(req!.path).toBe("/snapshot/load");
		expect(req!.body).toEqual(body);
	});

	test("deserializes instance-info response (GET /)", async () => {
		const responseBody: InstanceInfoResponse = {
			id: "test-instance",
			state: "Running",
			vmm_version: "1.5.0",
			app_name: "Firecracker",
		};
		mock.setResponse(200, responseBody);

		const info = await client.getInstanceInfo();
		expect(info).toEqual(responseBody);

		const req = mock.lastRequest();
		expect(req!.method).toBe("GET");
		expect(req!.path).toBe("/");
	});

	test("handles error responses with FirecrackerApiError", async () => {
		mock.setResponse(400, { fault_message: "Invalid kernel path" });

		try {
			await client.putBootSource({
				kernel_image_path: "",
			});
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(FirecrackerApiError);
			const apiErr = err as FirecrackerApiError;
			expect(apiErr.statusCode).toBe(400);
			expect(apiErr.endpoint).toBe("PUT /boot-source");
			expect(apiErr.faultMessage).toBe("Invalid kernel path");
		}
	});
});
