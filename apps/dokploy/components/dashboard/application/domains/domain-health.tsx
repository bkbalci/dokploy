import {
	Activity,
	AlertTriangle,
	CheckCircle2,
	Cloud,
	RefreshCw,
	Server,
	ShieldCheck,
	ShieldX,
	Waypoints,
	XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RouterOutputs } from "@/utils/api";

export type DomainRecord =
	| RouterOutputs["domain"]["byApplicationId"][0]
	| RouterOutputs["domain"]["byComposeId"][0];

export type DomainValidationState = {
	isLoading: boolean;
	isValid?: boolean;
	error?: string;
	resolvedIp?: string;
	message?: string;
	cdnProvider?: string;
};

export type DomainValidationStates = Record<string, DomainValidationState>;
export type DomainCloudflareDriftState = {
	isLoading: boolean;
	checkedAt?: string;
	status?: "healthy" | "drifted" | "error";
	issues?: string[];
	expectedService?: string | null;
	observedService?: string | null;
	expectedDnsTarget?: string | null;
	observedDnsTarget?: string | null;
	tunnelExists?: boolean;
	routeExists?: boolean;
	dnsExists?: boolean;
};

export type DomainCloudflareDriftStates = Record<string, DomainCloudflareDriftState>;

type DomainHealthSummary = {
	status: "healthy" | "warning" | "direct";
	statusLabel: string;
	exposureLabel: string;
	runtimeLabel: string | null;
	tunnelLabel: string | null;
	zoneLabel: string | null;
	originLabel: string;
	dnsLabel: string;
	sharedRuntimeStatusLabel: string | null;
	sharedRuntimeObservedLabel: string | null;
	sharedRuntimeMessage: string | null;
	sharedRuntimeNeedsRepair: boolean;
	issues: string[];
};

const getSharedRuntime = (domain: DomainRecord) =>
	"cloudflareSharedRuntime" in domain ? domain.cloudflareSharedRuntime : null;

const getRuntimeLabel = (domain: DomainRecord) => {
	if (!domain.publishToCloudflare) {
		return null;
	}

	switch (domain.cloudflareTunnelMode) {
		case "sidecar":
			return "Sidecar Connector";
		case "shared-managed":
			return "Shared Connector";
		default:
			return "Existing Connector";
	}
};

const getOriginLabel = (domain: DomainRecord) => {
	if (!domain.publishToCloudflare) {
		return domain.customEntrypoint
			? domain.customEntrypoint || "Custom entrypoint"
			: `${domain.host}:${domain.port}`;
	}

	if (domain.cloudflareTunnelMode === "sidecar") {
		if (!domain.serviceName || !domain.port) {
			return "Compose service target missing";
		}

		return `${domain.serviceName}:${domain.port}`;
	}

	if (domain.cloudflareTunnelMode === "shared-managed") {
		return domain.https ? "dokploy-traefik:443" : "dokploy-traefik:80";
	}

	return domain.https ? "Server:443" : "Server:80";
};

const getDomainHealthSummary = (domain: DomainRecord): DomainHealthSummary => {
	if (!domain.publishToCloudflare) {
		return {
			status: "direct",
			statusLabel: "Direct Routing",
			exposureLabel: "Dokploy DNS",
			runtimeLabel: null,
			tunnelLabel: null,
			zoneLabel: null,
			originLabel: getOriginLabel(domain),
			dnsLabel: "Managed outside Cloudflare Tunnel",
			sharedRuntimeStatusLabel: null,
			sharedRuntimeObservedLabel: null,
			sharedRuntimeMessage: null,
			sharedRuntimeNeedsRepair: false,
			issues: [],
		};
	}

	const issues: string[] = [];
	const sharedRuntime = getSharedRuntime(domain);

	if (!domain.cloudflareIntegrationId) {
		issues.push("Cloudflare integration is missing.");
	}

	if (!domain.cloudflareTunnelId || !domain.cloudflareTunnelName) {
		issues.push("Cloudflare tunnel selection is incomplete.");
	}

	if (!domain.cloudflareDnsRecordId) {
		issues.push("Managed Cloudflare DNS record is not tracked yet.");
	}

	if (!domain.cloudflareZoneId || !domain.cloudflareZoneName) {
		issues.push("Cloudflare zone metadata is missing.");
	}

	if (domain.cloudflareTunnelMode === "sidecar") {
		if (!domain.composeId) {
			issues.push("Sidecar mode requires a compose service.");
		}

		if (!domain.serviceName || !domain.port) {
			issues.push("Sidecar origin target is incomplete.");
		}
	}

	if (domain.cloudflareTunnelMode === "shared-managed") {
		if (!sharedRuntime) {
			issues.push("Shared connector runtime record could not be found.");
		} else {
			if (sharedRuntime.status !== "running") {
				issues.push(`Shared connector status is '${sharedRuntime.status}'.`);
			}

			if (sharedRuntime.observedHealth.status !== "healthy") {
				issues.push(
					`Shared connector live health is '${sharedRuntime.observedHealth.status}'.`,
				);
			}
		}
	}

	return {
		status: issues.length > 0 ? "warning" : "healthy",
		statusLabel: issues.length > 0 ? "Needs Attention" : "Cloudflare Healthy",
		exposureLabel: "Cloudflare Tunnel",
		runtimeLabel: getRuntimeLabel(domain),
		tunnelLabel: domain.cloudflareTunnelName || "Missing tunnel",
		zoneLabel: domain.cloudflareZoneName || "Missing zone",
		originLabel: getOriginLabel(domain),
		dnsLabel: domain.cloudflareDnsRecordId
			? "Managed DNS record"
			: "Pending DNS sync",
		sharedRuntimeStatusLabel: sharedRuntime
			? sharedRuntime.status
			: domain.cloudflareTunnelMode === "shared-managed"
				? "Missing runtime"
				: null,
		sharedRuntimeObservedLabel: sharedRuntime
			? `${sharedRuntime.observedHealth.status} (${sharedRuntime.observedHealth.state})`
			: null,
		sharedRuntimeMessage:
			sharedRuntime?.observedHealth.message || sharedRuntime?.lastError || null,
		sharedRuntimeNeedsRepair:
			!!sharedRuntime &&
			(sharedRuntime.status !== "running" ||
				sharedRuntime.observedHealth.status !== "healthy"),
		issues,
	};
};

const renderValidationBadge = (
	domain: DomainRecord,
	validationState?: DomainValidationState,
	onValidateDomain?: (host: string) => void,
) => {
	if (domain.host.includes("traefik.me") || !onValidateDomain) {
		return null;
	}

	return (
		<Button
			variant="outline"
			size="sm"
			className="h-8 gap-2"
			onClick={() => onValidateDomain(domain.host)}
		>
			{validationState?.isLoading ? (
				<>
					<RefreshCw className="size-3.5 animate-spin" />
					Checking DNS
				</>
			) : validationState?.isValid ? (
				<>
					<CheckCircle2 className="size-3.5 text-green-500" />
					{validationState.cdnProvider
						? `Behind ${validationState.cdnProvider}`
						: "DNS Valid"}
				</>
			) : validationState?.error ? (
				<>
					<XCircle className="size-3.5 text-red-500" />
					DNS Error
				</>
			) : (
				<>
					<RefreshCw className="size-3.5" />
					Validate DNS
				</>
			)}
		</Button>
	);
};

export const DomainHealthBadges = ({ domain }: { domain: DomainRecord }) => {
	const summary = getDomainHealthSummary(domain);

	return (
		<div className="flex flex-wrap gap-2">
			<Badge
				variant="outline"
				className={
					summary.status === "healthy"
						? "border-green-500/30 bg-green-500/10 text-green-600"
						: summary.status === "warning"
							? "border-yellow-500/30 bg-yellow-500/10 text-yellow-600"
							: "border-blue-500/30 bg-blue-500/10 text-blue-600"
				}
			>
				{summary.status === "healthy" ? (
					<ShieldCheck className="mr-1 size-3" />
				) : summary.status === "warning" ? (
					<ShieldX className="mr-1 size-3" />
				) : (
					<Server className="mr-1 size-3" />
				)}
				{summary.statusLabel}
			</Badge>
			{summary.runtimeLabel ? (
				<Badge variant="outline" className="capitalize">
					<Waypoints className="mr-1 size-3" />
					{summary.runtimeLabel}
				</Badge>
			) : null}
			{summary.sharedRuntimeStatusLabel ? (
				<Badge
					variant="outline"
					className={
						summary.sharedRuntimeNeedsRepair
							? "border-orange-500/30 bg-orange-500/10 text-orange-600"
							: "border-green-500/30 bg-green-500/10 text-green-600"
					}
				>
					<Activity className="mr-1 size-3" />
					{summary.sharedRuntimeNeedsRepair
						? "Shared Runtime Drift"
						: "Shared Runtime Healthy"}
				</Badge>
			) : null}
			{domain.publishToCloudflare ? (
				<Badge variant="outline">
					<Cloud className="mr-1 size-3" />
					{summary.dnsLabel}
				</Badge>
			) : null}
		</div>
	);
};

export const DomainHealthPanel = ({
	domain,
	validationState,
	onValidateDomain,
	canManageSharedRuntime,
	isReconcilingSharedRuntime,
	isRepairingSharedRuntime,
	onReconcileSharedRuntime,
	onRepairSharedRuntime,
	cloudflareDriftState,
	isDetectingCloudflareDrift,
	isRepairingCloudflareDrift,
	onDetectCloudflareDrift,
	onRepairCloudflareDrift,
}: {
	domain: DomainRecord;
	validationState?: DomainValidationState;
	onValidateDomain?: (host: string) => void;
	canManageSharedRuntime?: boolean;
	isReconcilingSharedRuntime?: boolean;
	isRepairingSharedRuntime?: boolean;
	onReconcileSharedRuntime?: (domain: DomainRecord) => void;
	onRepairSharedRuntime?: (domain: DomainRecord) => void;
	cloudflareDriftState?: DomainCloudflareDriftState;
	isDetectingCloudflareDrift?: boolean;
	isRepairingCloudflareDrift?: boolean;
	onDetectCloudflareDrift?: (domain: DomainRecord) => void;
	onRepairCloudflareDrift?: (domain: DomainRecord) => void;
}) => {
	const summary = getDomainHealthSummary(domain);
	const sharedRuntime = getSharedRuntime(domain);

	return (
		<div className="grid gap-3 rounded-lg border bg-muted/20 p-4">
			<div className="flex items-start justify-between gap-3 max-sm:flex-col">
				<div className="grid gap-2">
					<div className="text-sm font-medium">Health Overview</div>
					<DomainHealthBadges domain={domain} />
				</div>
				{renderValidationBadge(domain, validationState, onValidateDomain)}
			</div>

			{(domain.publishToCloudflare || (canManageSharedRuntime && sharedRuntime)) ? (
				<div className="flex flex-wrap gap-2">
					{domain.publishToCloudflare ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => onDetectCloudflareDrift?.(domain)}
							isLoading={isDetectingCloudflareDrift}
						>
							<RefreshCw className="mr-1 size-3.5" />
							Detect Drift
						</Button>
					) : null}
					{domain.publishToCloudflare ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => onRepairCloudflareDrift?.(domain)}
							isLoading={isRepairingCloudflareDrift}
							disabled={cloudflareDriftState?.status !== "drifted"}
						>
							<Activity className="mr-1 size-3.5" />
							Repair Drift
						</Button>
					) : null}
					{canManageSharedRuntime && sharedRuntime ? (
						<>
							<Button
								variant="outline"
								size="sm"
								onClick={() => onReconcileSharedRuntime?.(domain)}
								isLoading={isReconcilingSharedRuntime}
							>
								<RefreshCw className="mr-1 size-3.5" />
								Reconcile Runtime
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() => onRepairSharedRuntime?.(domain)}
								isLoading={isRepairingSharedRuntime}
								disabled={!summary.sharedRuntimeNeedsRepair}
							>
								<Activity className="mr-1 size-3.5" />
								Repair Runtime
							</Button>
						</>
					) : null}
				</div>
			) : null}

			<div className="grid gap-2 text-sm md:grid-cols-2">
				<div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
					<span className="text-muted-foreground">Exposure</span>
					<span className="font-medium">{summary.exposureLabel}</span>
				</div>
				<div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
					<span className="text-muted-foreground">Origin</span>
					<span className="font-medium">{summary.originLabel}</span>
				</div>
				{summary.runtimeLabel ? (
					<div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
						<span className="text-muted-foreground">Runtime</span>
						<span className="font-medium">{summary.runtimeLabel}</span>
					</div>
				) : null}
				{summary.sharedRuntimeStatusLabel ? (
					<div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
						<span className="text-muted-foreground">Connector Status</span>
						<span className="font-medium capitalize">
							{summary.sharedRuntimeStatusLabel}
						</span>
					</div>
				) : null}
				{summary.sharedRuntimeObservedLabel ? (
					<div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
						<span className="text-muted-foreground">Live Runtime</span>
						<span className="font-medium">
							{summary.sharedRuntimeObservedLabel}
						</span>
					</div>
				) : null}
				{summary.tunnelLabel ? (
					<div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
						<span className="text-muted-foreground">Tunnel</span>
						<span className="font-medium">{summary.tunnelLabel}</span>
					</div>
				) : null}
				{summary.zoneLabel ? (
					<div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
						<span className="text-muted-foreground">Zone</span>
						<span className="font-medium">{summary.zoneLabel}</span>
					</div>
				) : null}
				<div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
					<span className="text-muted-foreground">DNS</span>
					<span className="font-medium">{summary.dnsLabel}</span>
				</div>
			</div>

			{validationState?.resolvedIp ? (
				<div className="text-xs text-muted-foreground">
					Resolved IP: {validationState.resolvedIp}
				</div>
			) : null}

			{summary.sharedRuntimeMessage ? (
				<div className="grid gap-2 rounded-md border border-orange-500/30 bg-orange-500/5 p-3 text-sm text-orange-700 dark:text-orange-400">
					<div className="flex items-center gap-2 font-medium">
						<Activity className="size-4" />
						Shared Runtime Detail
					</div>
					<div>{summary.sharedRuntimeMessage}</div>
				</div>
			) : null}

			{cloudflareDriftState?.status ? (
				<div
					className={`grid gap-2 rounded-md border p-3 text-sm ${
						cloudflareDriftState.status === "healthy"
							? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400"
							: cloudflareDriftState.status === "drifted"
								? "border-yellow-500/30 bg-yellow-500/5 text-yellow-700 dark:text-yellow-500"
								: "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400"
					}`}
				>
					<div className="flex items-center gap-2 font-medium">
						<Activity className="size-4" />
						Cloudflare Drift Check
					</div>
					<div className="grid gap-1 text-xs sm:text-sm">
						<div>Status: {cloudflareDriftState.status}</div>
						<div>Tunnel exists: {cloudflareDriftState.tunnelExists ? "yes" : "no"}</div>
						<div>Ingress exists: {cloudflareDriftState.routeExists ? "yes" : "no"}</div>
						<div>DNS exists: {cloudflareDriftState.dnsExists ? "yes" : "no"}</div>
						{cloudflareDriftState.expectedService ? (
							<div>Expected origin: {cloudflareDriftState.expectedService}</div>
						) : null}
						{cloudflareDriftState.observedService ? (
							<div>Observed origin: {cloudflareDriftState.observedService}</div>
						) : null}
						{cloudflareDriftState.expectedDnsTarget ? (
							<div>Expected DNS: {cloudflareDriftState.expectedDnsTarget}</div>
						) : null}
						{cloudflareDriftState.observedDnsTarget ? (
							<div>Observed DNS: {cloudflareDriftState.observedDnsTarget}</div>
						) : null}
					</div>
					{cloudflareDriftState.issues?.length ? (
						<div className="grid gap-1">
							{cloudflareDriftState.issues.map((issue) => (
								<div key={issue}>{issue}</div>
							))}
						</div>
					) : (
						<div>Cloudflare route and DNS match Dokploy expectations.</div>
					)}
				</div>
			) : null}

			{summary.issues.length > 0 ? (
				<div className="grid gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm text-yellow-700 dark:text-yellow-500">
					<div className="flex items-center gap-2 font-medium">
						<AlertTriangle className="size-4" />
						Attention Needed
					</div>
					<div className="grid gap-1">
						{summary.issues.map((issue) => (
							<div key={issue}>{issue}</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
};
