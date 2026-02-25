export class PodmanRuntimeError extends Error {
	constructor(
		message: string,
		public readonly stderr?: string,
	) {
		super(message);
		this.name = "PodmanRuntimeError";
	}
}
