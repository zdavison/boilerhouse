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
	MachineConfigResponse,
	FirecrackerErrorBody,
} from "./types";

/** HTTP client for the Firecracker VMM REST API over a Unix domain socket. */
export class FirecrackerClient {
	constructor(private readonly socketPath: string) {}

	async putBootSource(body: BootSourceRequest): Promise<void> {
		await this.request("PUT", "/boot-source", body);
	}

	async putMachineConfig(body: MachineConfigRequest): Promise<void> {
		await this.request("PUT", "/machine-config", body);
	}

	async putDrive(driveId: string, body: DriveRequest): Promise<void> {
		await this.request("PUT", `/drives/${driveId}`, body);
	}

	/** Updates drive properties after snapshot load (e.g. path_on_host). */
	async patchDrive(
		driveId: string,
		body: Partial<DriveRequest>,
	): Promise<void> {
		await this.request("PATCH", `/drives/${driveId}`, body);
	}

	async putNetworkInterface(
		ifaceId: string,
		body: NetworkInterfaceRequest,
	): Promise<void> {
		await this.request("PUT", `/network-interfaces/${ifaceId}`, body);
	}

	async putAction(body: ActionRequest): Promise<void> {
		await this.request("PUT", "/actions", body);
	}

	async patchVm(body: VmUpdateRequest): Promise<void> {
		await this.request("PATCH", "/vm", body);
	}

	async putSnapshotCreate(body: SnapshotCreateRequest): Promise<void> {
		await this.request("PUT", "/snapshot/create", body);
	}

	async putSnapshotLoad(body: SnapshotLoadRequest): Promise<void> {
		await this.request("PUT", "/snapshot/load", body);
	}

	async getInstanceInfo(): Promise<InstanceInfoResponse> {
		return this.request("GET", "/") as Promise<InstanceInfoResponse>;
	}

	async getMachineConfig(): Promise<MachineConfigResponse> {
		return this.request(
			"GET",
			"/machine-config",
		) as Promise<MachineConfigResponse>;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<unknown> {
		const options: RequestInit & { unix: string } = {
			method,
			unix: this.socketPath,
			headers: body
				? { "Content-Type": "application/json", Accept: "application/json" }
				: { Accept: "application/json" },
		};

		if (body !== undefined) {
			options.body = JSON.stringify(body);
		}

		const response = await fetch(`http://localhost${path}`, options);

		if (!response.ok) {
			let faultMessage = `HTTP ${response.status}`;
			try {
				const errorBody = (await response.json()) as FirecrackerErrorBody;
				if (errorBody.fault_message) {
					faultMessage = errorBody.fault_message;
				}
			} catch {
				// Use default fault message if body is not JSON
			}
			throw new FirecrackerApiError(
				response.status,
				`${method} ${path}`,
				faultMessage,
			);
		}

		if (
			response.status === 204 ||
			response.headers.get("content-length") === "0"
		) {
			return undefined;
		}

		const contentType = response.headers.get("content-type");
		if (contentType?.includes("application/json")) {
			return response.json();
		}

		return undefined;
	}
}
