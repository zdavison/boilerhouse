import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Hash-based routing hook. Parses `window.location.hash` into a path and
 * extracts named parameters by matching against route patterns.
 *
 * @returns `[path, navigate]` where path is the current hash path (e.g. "/workloads")
 */
export function useHashRoute(): [string, (path: string) => void] {
	const [path, setPath] = useState(() => window.location.hash.slice(1) || "/");

	useEffect(() => {
		const onHashChange = () => {
			setPath(window.location.hash.slice(1) || "/");
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	const navigate = useCallback((newPath: string) => {
		window.location.hash = newPath;
	}, []);

	return [path, navigate];
}

/**
 * Matches a path against a pattern with `:param` segments.
 *
 * @example matchRoute("/workloads/my-app", "/workloads/:name") => { name: "my-app" }
 * @example matchRoute("/workloads", "/workloads/:name") => null
 */
export function matchRoute(
	path: string,
	pattern: string,
): Record<string, string> | null {
	const pathParts = path.split("/").filter(Boolean);
	const patternParts = pattern.split("/").filter(Boolean);

	if (pathParts.length !== patternParts.length) return null;

	const params: Record<string, string> = {};

	for (let i = 0; i < patternParts.length; i++) {
		const pat = patternParts[i]!;
		const val = pathParts[i]!;

		if (pat.startsWith(":")) {
			params[pat.slice(1)] = decodeURIComponent(val);
		} else if (pat !== val) {
			return null;
		}
	}

	return params;
}

interface UseApiResult<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
	refetch: () => void;
	/** Optimistically update the local data without refetching. */
	update: (fn: (prev: T | null) => T | null) => void;
}

/**
 * Calls a fetcher function on mount and provides `data`, `loading`, `error`, and `refetch`.
 */
export function useApi<T>(fetcher: () => Promise<T>): UseApiResult<T> {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;

	const hasData = useRef(false);

	const refetch = useCallback(() => {
		// Only show loading spinner on initial fetch, not on refreshes
		if (!hasData.current) {
			setLoading(true);
		}
		setError(null);
		fetcherRef
			.current()
			.then((result) => {
				hasData.current = true;
				setData(result);
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		refetch();
	}, [refetch]);

	const update = useCallback((fn: (prev: T | null) => T | null) => {
		setData(fn);
	}, []);

	return { data, loading, error, refetch, update };
}

/**
 * Auto-refresh hook for periodic data fetching.
 *
 * @param refetch - Function to call on each interval tick
 * @param defaultInterval - Initial interval in ms (0 = paused)
 * @default 10000
 */
export function useAutoRefresh(
	refetch: () => void,
	defaultInterval = 10000,
): {
	interval: number;
	setInterval: (ms: number) => void;
	paused: boolean;
	setPaused: (paused: boolean) => void;
} {
	const [interval, setIntervalState] = useState(defaultInterval);
	const [paused, setPaused] = useState(defaultInterval === 0);
	const refetchRef = useRef(refetch);
	refetchRef.current = refetch;

	useEffect(() => {
		if (paused || interval === 0) return;
		const timer = setInterval(() => refetchRef.current(), interval);
		return () => clearInterval(timer);
	}, [interval, paused]);

	return {
		interval,
		setInterval: setIntervalState,
		paused,
		setPaused,
	};
}

/**
 * Auto-reconnecting WebSocket hook. Connects to the dashboard server's `/ws`
 * endpoint and calls `onEvent` for each parsed JSON message.
 */
export function useWebSocket(onEvent: (event: unknown) => void): void {
	const onEventRef = useRef(onEvent);
	onEventRef.current = onEvent;

	useEffect(() => {
		let ws: WebSocket | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout>;
		let delay = 1000;
		let unmounted = false;

		function connect() {
			if (unmounted) return;
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

			ws.onopen = () => {
				delay = 1000;
			};

			ws.onmessage = (event) => {
				try {
					const data: unknown = JSON.parse(event.data as string);
					onEventRef.current(data);
				} catch {
					// ignore non-JSON messages
				}
			};

			ws.onclose = () => {
				if (unmounted) return;
				reconnectTimer = setTimeout(connect, delay);
				delay = Math.min(delay * 2, 30000);
			};
		}

		connect();

		return () => {
			unmounted = true;
			clearTimeout(reconnectTimer);
			ws?.close();
		};
	}, []);
}
