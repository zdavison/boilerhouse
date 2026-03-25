/**
 * Platform-aware default paths for Boilerhouse.
 *
 * macOS: user-local paths under ~/.local/share/boilerhouse/
 * Linux: system paths under /var/run/ and /var/lib/
 */

const IS_MACOS = process.platform === "darwin";
const HOME = process.env.HOME ?? "/tmp";

/** Default Docker daemon socket path. */
export const DEFAULT_DOCKER_SOCKET = IS_MACOS
	? "/var/run/docker.sock"
	: "/var/run/docker.sock";

/** Default storage directory for Boilerhouse data. */
export const DEFAULT_STORAGE_DIR = IS_MACOS
	? `${HOME}/.local/share/boilerhouse`
	: "/var/lib/boilerhouse";
