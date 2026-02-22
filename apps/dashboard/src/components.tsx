import { useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { api, type InstanceEndpoint } from "./api";
import { ClipboardCopy, Check } from "lucide-react";

// --- Status Indicator ---

const STATUS_SYMBOLS: Record<string, string> = {
	active: "●",
	online: "●",
	ready: "●",
	starting: "◐",
	creating: "◐",
	draining: "◐",
	destroying: "◐",
	hibernated: "○",
	destroyed: "✕",
	offline: "✕",
	error: "✕",
};

const STATUS_COLORS: Record<string, string> = {
	active: "text-status-green",
	online: "text-status-green",
	ready: "text-status-green",
	starting: "text-status-yellow",
	creating: "text-status-yellow",
	draining: "text-status-yellow",
	destroying: "text-status-orange",
	hibernated: "text-status-blue",
	destroyed: "text-status-red",
	offline: "text-status-red",
	error: "text-status-red",
};

export function StatusIndicator({ status, detail }: { status: string; detail?: string }) {
	const symbol = STATUS_SYMBOLS[status] ?? "●";
	const color = STATUS_COLORS[status] ?? "text-muted";
	const hasErrorDetail = status === "error" && !!detail;
	const [showModal, setShowModal] = useState(false);

	if (hasErrorDetail) {
		return (
			<>
				<span
					className={`font-mono text-sm leading-none ${color} cursor-pointer hover:opacity-80 transition-opacity`}
					title="Click to view error details"
					onClick={(e) => {
						e.stopPropagation();
						setShowModal(true);
					}}
				>
					{symbol}
				</span>
				{showModal && (
					<ErrorDetailModal
						detail={detail}
						onClose={() => setShowModal(false)}
					/>
				)}
			</>
		);
	}

	const tooltip = detail ? `${status}: ${detail}` : status;

	return (
		<span className={`font-mono text-sm leading-none ${color} cursor-default`} title={tooltip}>
			{symbol}
		</span>
	);
}

// --- Error Detail Modal ---

function ErrorDetailModal({ detail, onClose }: { detail: string; onClose: () => void }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		await navigator.clipboard.writeText(detail);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}, [detail]);

	return (
		<Modal title="Error Details" onClose={onClose}>
			<div className="space-y-3">
				<pre className="bg-surface-2 rounded-md p-3 text-sm font-mono text-status-red whitespace-pre-wrap break-words max-h-80 overflow-y-auto select-all">
					{detail}
				</pre>
				<button
					onClick={handleCopy}
					className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded border transition-colors ${
						copied
							? "text-status-green border-status-green/30 bg-status-green/10"
							: "text-muted-light border-border hover:bg-surface-3"
					}`}
				>
					{copied ? <Check size={13} /> : <ClipboardCopy size={13} />}
					{copied ? "copied" : "copy to clipboard"}
				</button>
			</div>
		</Modal>
	);
}

// --- Info Card ---

export function InfoCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-surface-2 rounded-md p-4">
			<p className="text-xs font-tight uppercase tracking-wider text-muted mb-1">{label}</p>
			<p className="text-sm font-mono text-gray-200 break-all">{value}</p>
		</div>
	);
}

// --- Stat Card ---

export function StatCard({ label, value }: { label: string; value: number }) {
	return (
		<div className="bg-surface-2 rounded-md p-5">
			<p className="text-sm text-muted-light">{label}</p>
			<p className="text-3xl font-bold font-mono mt-1">{value}</p>
		</div>
	);
}

// --- Data Table ---

export function DataTable({
	headers,
	children,
}: {
	headers: string[];
	children: ReactNode;
}) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm text-left">
				<thead className="text-xs font-tight uppercase tracking-wider text-muted border-b border-border/30">
					<tr>
						{headers.map((h) => (
							<th key={h} className="px-4 py-3">
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="font-mono">{children}</tbody>
			</table>
		</div>
	);
}

export function DataRow({
	children,
	onClick,
}: {
	children: ReactNode;
	onClick?: () => void;
}) {
	return (
		<tr
			className={`border-b border-border/30 hover:bg-surface-3/50 transition-colors ${onClick ? "cursor-pointer" : ""}`}
			onClick={onClick}
		>
			{children}
		</tr>
	);
}

// --- Loading State ---

export function LoadingState() {
	return (
		<div className="py-20 text-center">
			<span className="font-mono text-muted animate-pulse">loading...</span>
		</div>
	);
}

// --- Error State ---

export function ErrorState({ message }: { message: string }) {
	return (
		<div className="bg-status-red/10 rounded-md p-4">
			<p className="font-mono text-sm text-status-red">{message}</p>
		</div>
	);
}

// --- Page Header ---

export function PageHeader({ children }: { children: ReactNode }) {
	return <h2 className="text-xl font-tight font-semibold mb-6">{children}</h2>;
}

// --- Back Link ---

export function BackLink({
	href,
	label,
	onClick,
}: {
	href?: string;
	label: string;
	onClick?: () => void;
}) {
	if (onClick) {
		return (
			<button
				onClick={onClick}
				className="font-mono text-sm text-muted hover:text-accent transition-colors mb-4 inline-block"
			>
				&larr; {label}
			</button>
		);
	}
	return (
		<a
			href={href}
			className="font-mono text-sm text-muted hover:text-accent transition-colors mb-4 inline-block"
		>
			&larr; {label}
		</a>
	);
}

// --- Modal ---

export function Modal({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			onClick={onClose}
		>
			<div
				className="bg-surface-1 border border-border rounded-lg shadow-xl w-full max-w-md mx-4"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<h3 className="text-sm font-tight font-semibold">{title}</h3>
					<button
						onClick={onClose}
						className="text-muted hover:text-white transition-colors text-lg leading-none"
					>
						&times;
					</button>
				</div>
				<div className="p-4">{children}</div>
			</div>
		</div>
	);
}

// --- Connection Modal ---

export function ConnectionModal({
	instanceId,
	onClose,
}: {
	instanceId: string;
	onClose: () => void;
}) {
	const [endpointData, setEndpointData] = useState<InstanceEndpoint | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.fetchInstanceEndpoint(instanceId)
			.then((data) => {
				setEndpointData(data);
				setLoading(false);
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : "Failed to fetch endpoint");
				setLoading(false);
			});
	}, [instanceId]);

	return (
		<Modal title="Connection Details" onClose={onClose}>
			{loading && (
				<p className="font-mono text-sm text-muted animate-pulse">loading...</p>
			)}
			{error && (
				<p className="font-mono text-sm text-status-red">{error}</p>
			)}
			{endpointData && (
				<div className="space-y-3">
					<div className="grid grid-cols-2 gap-3">
						<InfoCard label="Host" value={endpointData.endpoint.host} />
						<InfoCard label="Ports" value={endpointData.endpoint.ports.join(", ")} />
					</div>
					<InfoCard label="Instance" value={endpointData.instanceId} />
					<InfoCard label="Status" value={endpointData.status} />
					<div className="bg-surface-2 rounded-md p-3">
						<p className="text-xs font-tight uppercase tracking-wider text-muted mb-2">Connect via</p>
						{endpointData.endpoint.ports.map((port: number) => (
							<pre key={port} className="text-xs font-mono text-muted-light select-all mt-1">
								curl http://{endpointData.endpoint.host}:{port}/
							</pre>
						))}
					</div>
				</div>
			)}
		</Modal>
	);
}

// --- Action Button ---

const ACTION_VARIANTS: Record<string, string> = {
	danger: "text-status-red hover:bg-status-red/10",
	warning: "text-status-yellow hover:bg-status-yellow/10",
	info: "text-status-blue hover:bg-status-blue/10",
};

export function ActionButton({
	label,
	variant,
	onClick,
	disabled,
}: {
	label: string;
	variant: "danger" | "warning" | "info";
	onClick: () => void;
	/** @default false */
	disabled?: boolean;
}) {
	return (
		<button
			disabled={disabled}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={`px-2 py-1 text-xs font-mono lowercase rounded-sm transition-colors ${ACTION_VARIANTS[variant]} disabled:opacity-50 disabled:pointer-events-none`}
		>
			{label}
		</button>
	);
}
