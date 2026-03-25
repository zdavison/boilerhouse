export class DockerRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DockerRuntimeError";
	}
}
