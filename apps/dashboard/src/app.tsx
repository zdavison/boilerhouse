import { useState, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { Flame, Package, HardDrive, ScrollText } from "lucide-react";
import { createRoot } from "react-dom/client";
import { useHashRoute, matchRoute, useWebSocket } from "./hooks";
import { WorkloadList } from "./pages/WorkloadList";
import { WorkloadDetail } from "./pages/WorkloadDetail";
import { NodeList } from "./pages/NodeList";
import { ActivityLog } from "./pages/ActivityLog";

const NAV_ITEMS: { path: string; label: string; icon: LucideIcon }[] = [
	{ path: "/workloads", label: "workloads", icon: Package },
	{ path: "/nodes", label: "nodes", icon: HardDrive },
	{ path: "/logs", label: "logs", icon: ScrollText },
];

function App() {
	const [path, navigate] = useHashRoute();
	// Increment to force refetch on WS events
	const [tick, setTick] = useState(0);
	const refetch = useCallback(() => setTick((t) => t + 1), []);

	useWebSocket((event: unknown) => {
		const e = event as { type?: string };
		if (e.type !== "bootstrap.log") refetch();
	});

	let content: React.ReactNode;
	let params: Record<string, string> | null;

	if (path === "/" || path === "/workloads") {
		content = <WorkloadList key={tick} navigate={navigate} />;
	} else if ((params = matchRoute(path, "/workloads/:name"))) {
		content = <WorkloadDetail key={`${params.name}-${tick}`} name={params.name!} navigate={navigate} />;
	} else if (path === "/nodes") {
		content = <NodeList key={tick} />;
	} else if (path === "/logs") {
		content = <ActivityLog key={tick} />;
	} else {
		content = (
			<div className="text-center py-20 text-muted">
				<h2 className="text-xl font-tight font-semibold mb-2">not found</h2>
				<p className="font-mono text-sm">
					the page <code className="text-accent">{path}</code> does not exist.
				</p>
			</div>
		);
	}

	return (
		<div className="flex h-screen">
			{/* Sidebar */}
			<nav className="w-48 bg-surface-1 flex flex-col">
				<div className="px-4 py-5 flex items-center gap-2">
					<Flame size={18} className="text-accent shrink-0" />
					<h1 className="text-base font-tight font-bold tracking-tight text-white">
						boilerhouse
					</h1>
				</div>
				<ul className="flex-1 py-1">
					{NAV_ITEMS.map((item) => {
						const active =
							item.path === "/workloads"
								? path === "/" || path === "/workloads" || path.startsWith("/workloads/")
								: path === item.path || path.startsWith(item.path + "/");
						const Icon = item.icon;
						return (
							<li key={item.path}>
								<a
									href={`#${item.path}`}
									className={`flex items-center gap-2.5 px-4 py-1.5 font-mono text-sm transition-colors ${
										active
											? "bg-surface-3 text-white"
											: "text-muted-light hover:text-white hover:bg-surface-3/50"
									}`}
								>
									<Icon size={14} className="shrink-0" />
									{item.label}
								</a>
							</li>
						);
					})}
				</ul>
			</nav>

			{/* Main content */}
			<main className="flex-1 overflow-auto p-8">
				{content}
			</main>
		</div>
	);
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
