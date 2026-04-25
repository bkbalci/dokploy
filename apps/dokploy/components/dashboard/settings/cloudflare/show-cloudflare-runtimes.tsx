import { formatDate } from "date-fns";
import {
	Activity,
	CloudCog,
	Loader2,
	RefreshCw,
	RotateCcw,
	Server,
	Trash2,
	Waypoints,
	Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

const getStatusClasses = (status: string) => {
	switch (status) {
		case "running":
			return "border-green-500/30 bg-green-500/10 text-green-600";
		case "error":
			return "border-red-500/30 bg-red-500/10 text-red-600";
		case "pending":
			return "border-yellow-500/30 bg-yellow-500/10 text-yellow-600";
		default:
			return "border-muted bg-muted/50 text-muted-foreground";
	}
};

const getObservedHealthClasses = (status: string) => {
	switch (status) {
		case "healthy":
			return "border-green-500/30 bg-green-500/10 text-green-600";
		case "degraded":
			return "border-yellow-500/30 bg-yellow-500/10 text-yellow-600";
		case "unhealthy":
			return "border-red-500/30 bg-red-500/10 text-red-600";
		default:
			return "border-muted bg-muted/50 text-muted-foreground";
	}
};

export const ShowCloudflareRuntimes = () => {
	const utils = api.useUtils();
	const { data, isPending, refetch, isRefetching } =
		api.cloudflare.sharedRuntimes.useQuery(undefined, {
			refetchInterval: 30000,
			refetchOnWindowFocus: false,
		});
	const { mutateAsync: restartRuntime, isPending: isRestarting } =
		api.cloudflare.restartSharedRuntime.useMutation();
	const { mutateAsync: recreateRuntime, isPending: isRecreating } =
		api.cloudflare.recreateSharedRuntime.useMutation();
	const { mutateAsync: cleanupUnusedRuntimes, isPending: isCleaning } =
		api.cloudflare.cleanupUnusedSharedRuntimes.useMutation();

	const orphanedRuntimes = data?.filter((runtime) => runtime.referenceCount === 0) || [];

	const refreshRuntimeData = async () => {
		await utils.cloudflare.sharedRuntimes.invalidate();
		await refetch();
	};

	return (
		<Card className="bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader className="flex flex-row items-start justify-between gap-4 max-sm:flex-col">
					<div>
						<CardTitle className="text-xl flex flex-row gap-2 items-center">
							<CloudCog className="size-6 text-muted-foreground" />
							Managed Shared Connectors
						</CardTitle>
						<CardDescription>
							Inspect and operate Dokploy-managed shared Cloudflare tunnel runtimes.
						</CardDescription>
					</div>
					<div className="flex gap-2 flex-wrap">
						<Button
							variant="outline"
							onClick={() => refreshRuntimeData()}
							isLoading={isRefetching}
						>
							<RefreshCw className="size-4" /> Refresh
						</Button>
						<Button
							variant="outline"
							onClick={async () => {
								await cleanupUnusedRuntimes()
									.then(async (result) => {
										toast.success(
											result.cleanedCount > 0
												? `Cleaned ${result.cleanedCount} unused shared runtimes`
												: "No unused shared runtimes found",
										);
										await refreshRuntimeData();
									})
									.catch((error) => {
										toast.error("Failed to clean shared runtimes", {
											description:
												error instanceof Error ? error.message : "Unknown error",
										});
									});
							}}
							isLoading={isCleaning}
							disabled={orphanedRuntimes.length === 0}
						>
							<Trash2 className="size-4" /> Cleanup Unused
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-4 border-t py-8">
					{isPending ? (
						<div className="flex min-h-[18vh] items-center justify-center gap-2 text-sm text-muted-foreground">
							<span>Loading shared runtimes...</span>
							<Loader2 className="size-4 animate-spin" />
						</div>
					) : !data || data.length === 0 ? (
						<div className="flex min-h-[18vh] flex-col items-center justify-center gap-3 text-center text-muted-foreground">
							<Waypoints className="size-8" />
							<span>No shared Cloudflare runtimes have been created yet.</span>
						</div>
					) : (
						<div className="grid gap-4">
							{data.map((runtime) => (
								<div
									key={runtime.cloudflareTunnelRuntimeId}
									className="rounded-lg border bg-sidebar p-1"
								>
									<div className="flex h-full flex-col gap-4 rounded-lg border bg-background p-4">
										<div className="flex items-start justify-between gap-4 max-sm:flex-col">
											<div className="grid gap-2">
												<div className="flex items-center gap-2 flex-wrap">
													<span className="text-sm font-medium">{runtime.cloudflareTunnelName}</span>
													<Badge variant="secondary">{runtime.integrationName}</Badge>
													<Badge variant="outline" className={getStatusClasses(runtime.status)}>
														{runtime.status}
													</Badge>
													<Badge
														variant="outline"
														className={getObservedHealthClasses(runtime.observedHealth.status)}
													>
														Live {runtime.observedHealth.status}
													</Badge>
													<Badge variant="outline" className="capitalize">
														{runtime.resourceType}
													</Badge>
													{runtime.referenceCount === 0 ? (
														<Badge variant="outline" className="border-yellow-500/30 bg-yellow-500/10 text-yellow-600">
															Unused
														</Badge>
													) : null}
												</div>
												<div className="text-xs text-muted-foreground grid gap-1">
													<span>Server: {runtime.serverName || "Local Docker host"}</span>
													<span>Resource: {runtime.dockerResourceName}</span>
													<span>
														Last seen: {formatDate(new Date(runtime.lastSeenAt || runtime.updatedAt), "yyyy-MM-dd HH:mm:ss")}
													</span>
													<span>
														Observed at: {formatDate(new Date(runtime.observedHealth.observedAt), "yyyy-MM-dd HH:mm:ss")}
													</span>
													<span>
														Last started: {runtime.lastStartedAt ? formatDate(new Date(runtime.lastStartedAt), "yyyy-MM-dd HH:mm:ss") : "Not recorded"}
													</span>
												</div>
											</div>
											<div className="flex gap-2 flex-wrap">
												<Button
													variant="outline"
													onClick={async () => {
														await restartRuntime({
															cloudflareTunnelRuntimeId: runtime.cloudflareTunnelRuntimeId,
														})
															.then(async () => {
																toast.success("Shared runtime restarted");
																await refreshRuntimeData();
															})
															.catch((error) => {
																toast.error("Failed to restart shared runtime", {
																	description:
																		error instanceof Error ? error.message : "Unknown error",
																});
															});
													}}
													isLoading={isRestarting}
												>
													<RotateCcw className="size-4" /> Restart
												</Button>
												<Button
													variant="outline"
													onClick={async () => {
														await recreateRuntime({
															cloudflareTunnelRuntimeId: runtime.cloudflareTunnelRuntimeId,
														})
															.then(async () => {
																toast.success("Shared runtime recreated");
																await refreshRuntimeData();
															})
															.catch((error) => {
																toast.error("Failed to recreate shared runtime", {
																	description:
																		error instanceof Error ? error.message : "Unknown error",
																});
															});
													}}
													isLoading={isRecreating}
												>
													<Wrench className="size-4" /> Recreate
												</Button>
											</div>
										</div>

										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-md border bg-muted/20 p-3 text-sm">
												<div className="text-xs uppercase tracking-wide text-muted-foreground">
													Referenced Domains
												</div>
												<div className="mt-2 flex items-center gap-2 flex-wrap">
													<Badge variant="secondary">{runtime.referenceCount} domains</Badge>
													{runtime.references.slice(0, 4).map((reference) => (
														<Badge key={reference.domainId} variant="outline">
															{reference.host}
															{reference.path && reference.path !== "/" ? reference.path : ""}
														</Badge>
													))}
													{runtime.references.length > 4 ? (
														<Badge variant="outline">+{runtime.references.length - 4} more</Badge>
													) : null}
												</div>
											</div>
											<div className="rounded-md border bg-muted/20 p-3 text-sm">
												<div className="text-xs uppercase tracking-wide text-muted-foreground">
													Live Runtime Health
												</div>
												<div className="mt-2 grid gap-2 text-muted-foreground">
													<div className="flex items-center gap-2">
														<Activity className="size-4" />
														<span>
															{runtime.observedHealth.status} ({runtime.observedHealth.state})
														</span>
													</div>
													<div className="flex items-center gap-2">
														<Server className="size-4" />
														<span>{runtime.serverName || "Local Docker host"}</span>
													</div>
													<div className="flex items-center gap-2">
														<Waypoints className="size-4" />
														<span>{runtime.resourceType} resource</span>
													</div>
													<div className="flex items-center gap-2">
														<CloudCog className="size-4" />
														<span>{runtime.cloudflareTunnelId}</span>
													</div>
													{runtime.observedHealth.desiredReplicas !== null ? (
														<div className="flex items-center gap-2">
															<Waypoints className="size-4" />
															<span>
																{runtime.observedHealth.runningTasks ?? 0}/
																{runtime.observedHealth.desiredReplicas} running
															</span>
														</div>
													) : null}
													{runtime.observedHealth.exitCode !== null ? (
														<div className="flex items-center gap-2">
															<Wrench className="size-4" />
															<span>Exit code: {runtime.observedHealth.exitCode}</span>
														</div>
													) : null}
												</div>
											</div>
										</div>

										{runtime.observedHealth.message ? (
											<div className="rounded-md border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm text-yellow-700">
												<div className="font-medium">Observed Runtime Message</div>
												<div className="mt-1 break-words">{runtime.observedHealth.message}</div>
											</div>
										) : null}

										{runtime.lastError ? (
											<div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600">
												<div className="font-medium">Last Error</div>
												<div className="mt-1 break-words">{runtime.lastError}</div>
											</div>
										) : null}
									</div>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</div>
		</Card>
	);
};