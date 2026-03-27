// BOILERHOUSE_VERSION is injected at build time via --define.
// Falls back to "dev" when running from source.
declare const BOILERHOUSE_VERSION: string;

export function versionCommand(): void {
	const version =
		typeof BOILERHOUSE_VERSION !== "undefined" ? BOILERHOUSE_VERSION : "dev";
	console.log(`boilerhouse ${version}`);
}
