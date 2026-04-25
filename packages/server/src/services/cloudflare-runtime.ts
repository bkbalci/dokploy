import { db } from "@dokploy/server/db";
import { cloudflareTunnelRuntime, domains } from "@dokploy/server/db/schema";
import { getDockerResourceType } from "@dokploy/server/services/settings";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { TRPCError } from "@trpc/server";
import type { ContainerCreateOptions, CreateServiceOptions } from "dockerode";
import { and, eq, isNull, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { findApplicationById } from "./application";
import {
    findCloudflareIntegrationById,
    getCloudflareTunnelToken,
} from "./cloudflare";
import { findComposeById } from "./compose";

const CLOUDFLARED_IMAGE = "cloudflare/cloudflared:latest";
const DOKPLOY_NETWORK = "dokploy-network";
const TRAEFIK_RESOURCE_NAME = "dokploy-traefik";
const SHARED_RUNTIME_RECONCILE_JOB_NAME =
    "cloudflare-shared-runtime-reconcile";
const SHARED_RUNTIME_RECONCILE_CRON = "*/5 * * * *";

export type CloudflareTunnelRuntime =
    typeof cloudflareTunnelRuntime.$inferSelect;

export type CloudflareTunnelRuntimeReference = {
    domainId: string;
    host: string;
    path: string | null;
};

export type CloudflareTunnelRuntimeObservedHealth = {
    observedAt: string;
    status: "healthy" | "degraded" | "unhealthy" | "missing";
    state: string;
    message: string | null;
    desiredReplicas: number | null;
    runningTasks: number | null;
    totalTasks: number | null;
    exitCode: number | null;
};

export type SharedManagedCloudflareTunnelRuntimeSummary = CloudflareTunnelRuntime & {
    resourceType: "service" | "standalone" | "unknown";
    referenceCount: number;
    references: CloudflareTunnelRuntimeReference[];
    integrationName: string;
    serverName: string | null;
    observedHealth: CloudflareTunnelRuntimeObservedHealth;
};

export type SharedManagedCloudflareTunnelRuntimeReconcileResult = {
    checkedAt: string;
    reconciledCount: number;
    changedCount: number;
    failedCount: number;
};

export type SharedManagedCloudflareTunnelRuntimeRepairResult = {
    checkedAt: string;
    attemptedCount: number;
    repairedCount: number;
    skippedCount: number;
    failedCount: number;
};

type RuntimeScope = {
    organizationId: string;
    serverId?: string | null;
    cloudflareIntegrationId: string;
    cloudflareTunnelId: string;
};

type DomainBinding = {
    domainId?: string;
    applicationId?: string | null;
    composeId?: string | null;
    cloudflareTunnelMode?: string | null;
    cloudflareIntegrationId?: string | null;
    cloudflareTunnelId?: string | null;
    cloudflareTunnelName?: string | null;
};

const getSharedRuntimeResourceName = (runtimeId: string) => {
    return `dokploy-cloudflared-shared-${runtimeId.slice(0, 12)}`;
};

const now = () => new Date().toISOString();

const resolveServerIdFromBinding = async (binding: DomainBinding) => {
    if (binding.applicationId) {
        const application = await findApplicationById(binding.applicationId);
        return application.serverId ?? null;
    }

    if (binding.composeId) {
        const compose = await findComposeById(binding.composeId);
        return compose.serverId ?? null;
    }

    return null;
};

const findRuntimeByScope = async (scope: RuntimeScope) => {
    return db.query.cloudflareTunnelRuntime.findFirst({
        where: and(
            eq(cloudflareTunnelRuntime.organizationId, scope.organizationId),
            scope.serverId
                ? eq(cloudflareTunnelRuntime.serverId, scope.serverId)
                : isNull(cloudflareTunnelRuntime.serverId),
            eq(
                cloudflareTunnelRuntime.cloudflareIntegrationId,
                scope.cloudflareIntegrationId,
            ),
            eq(cloudflareTunnelRuntime.cloudflareTunnelId, scope.cloudflareTunnelId),
        ),
    });
};

const findRuntimeById = async (runtimeId: string) => {
    return db.query.cloudflareTunnelRuntime.findFirst({
        where: eq(cloudflareTunnelRuntime.cloudflareTunnelRuntimeId, runtimeId),
        with: {
            server: {
                columns: {
                    name: true,
                    serverId: true,
                },
            },
            cloudflareIntegration: {
                columns: {
                    name: true,
                    cloudflareIntegrationId: true,
                },
            },
        },
    });
};

const updateRuntimeById = async (
    runtimeId: string,
    data: Partial<CloudflareTunnelRuntime>,
) => {
    return db
        .update(cloudflareTunnelRuntime)
        .set({
            ...data,
            updatedAt: now(),
        })
        .where(eq(cloudflareTunnelRuntime.cloudflareTunnelRuntimeId, runtimeId))
        .returning()
        .then((result) => result[0]);
};

const removeRuntimeById = async (runtimeId: string) => {
    return db
        .delete(cloudflareTunnelRuntime)
        .where(eq(cloudflareTunnelRuntime.cloudflareTunnelRuntimeId, runtimeId));
};

const pullCloudflaredImage = async (serverId?: string | null) => {
    const docker = await getRemoteDocker(serverId);
    try {
        await docker.pull(CLOUDFLARED_IMAGE);
    } catch {
        return;
    }
};

const createStandaloneRuntime = async ({
    serverId,
    resourceName,
    token,
}: {
    serverId?: string | null;
    resourceName: string;
    token: string;
}) => {
    const docker = await getRemoteDocker(serverId);
    const settings: ContainerCreateOptions = {
        name: resourceName,
        Image: CLOUDFLARED_IMAGE,
        Cmd: ["tunnel", "--no-autoupdate", "run", "--token", token],
        NetworkingConfig: {
            EndpointsConfig: {
                [DOKPLOY_NETWORK]: {},
            },
        },
        HostConfig: {
            RestartPolicy: {
                Name: "always",
            },
        },
    };

    const container = docker.getContainer(resourceName);
    try {
        const inspect = await container.inspect();
        if (inspect.State?.Running) {
            return;
        }
        await container.start();
        return;
    } catch {
        await docker.createContainer(settings);
        await docker.getContainer(resourceName).start();
    }
};

const createServiceRuntime = async ({
    serverId,
    resourceName,
    token,
}: {
    serverId?: string | null;
    resourceName: string;
    token: string;
}) => {
    const docker = await getRemoteDocker(serverId);
    const service = docker.getService(resourceName);
    const settings: CreateServiceOptions = {
        Name: resourceName,
        TaskTemplate: {
            ContainerSpec: {
                Image: CLOUDFLARED_IMAGE,
                Command: ["tunnel", "--no-autoupdate", "run", "--token", token],
            },
            Networks: [{ Target: DOKPLOY_NETWORK }],
            RestartPolicy: {
                Condition: "any",
            },
        },
        Mode: {
            Replicated: {
                Replicas: 1,
            },
        },
    };

    try {
        await service.inspect();
        return;
    } catch {
        await docker.createService(settings);
    }
};

const ensureRuntimeResource = async (runtime: CloudflareTunnelRuntime) => {
    const integration = await findCloudflareIntegrationById(
        runtime.cloudflareIntegrationId,
    );
    const token = await getCloudflareTunnelToken({
        apiToken: integration.apiToken,
        accountId: integration.accountId,
        tunnelId: runtime.cloudflareTunnelId,
    });

    await pullCloudflaredImage(runtime.serverId);

    const traefikResourceType = await getDockerResourceType(
        TRAEFIK_RESOURCE_NAME,
        runtime.serverId || undefined,
    );

    if (traefikResourceType === "unknown") {
        throw new TRPCError({
            code: "BAD_REQUEST",
            message:
                "Dokploy Traefik runtime was not found on the selected server. Shared-managed Cloudflare connector requires Dokploy Traefik to be running first.",
        });
    }

    const existingRuntimeType = await getDockerResourceType(
        runtime.dockerResourceName,
        runtime.serverId || undefined,
    );
    const docker = await getRemoteDocker(runtime.serverId);

    if (
        existingRuntimeType !== "unknown" &&
        existingRuntimeType !== traefikResourceType
    ) {
        if (existingRuntimeType === "service") {
            await docker.getService(runtime.dockerResourceName).remove();
        } else {
            await docker
                .getContainer(runtime.dockerResourceName)
                .remove({ force: true });
        }
    }

    if (traefikResourceType === "service") {
        await createServiceRuntime({
            serverId: runtime.serverId,
            resourceName: runtime.dockerResourceName,
            token,
        });
        return;
    }

    await createStandaloneRuntime({
        serverId: runtime.serverId,
        resourceName: runtime.dockerResourceName,
        token,
    });
};

const removeRuntimeResource = async (runtime: CloudflareTunnelRuntime) => {
    const docker = await getRemoteDocker(runtime.serverId);
    const runtimeResourceType = await getDockerResourceType(
        runtime.dockerResourceName,
        runtime.serverId || undefined,
    );

    if (runtimeResourceType === "service") {
        await docker
            .getService(runtime.dockerResourceName)
            .remove()
            .catch(() => null);
    } else if (runtimeResourceType === "standalone") {
        await docker
            .getContainer(runtime.dockerResourceName)
            .remove({ force: true })
            .catch(() => null);
    }

    return runtimeResourceType;
};

const restartRuntimeResource = async (runtime: CloudflareTunnelRuntime) => {
    const resourceType = await getDockerResourceType(
        runtime.dockerResourceName,
        runtime.serverId || undefined,
    );

    if (resourceType === "unknown") {
        throw new TRPCError({
            code: "NOT_FOUND",
            message: "Cloudflare shared runtime container/service was not found",
        });
    }

    const docker = await getRemoteDocker(runtime.serverId);

    if (resourceType === "service") {
        const service = docker.getService(runtime.dockerResourceName);
        const inspect = await service.inspect();

        await service.update({
            version: Number.parseInt(inspect.Version.Index),
            ...inspect.Spec,
            TaskTemplate: {
                ...inspect.Spec.TaskTemplate,
                ForceUpdate: (inspect.Spec.TaskTemplate.ForceUpdate ?? 0) + 1,
            },
        });
        return resourceType;
    }

    await docker.getContainer(runtime.dockerResourceName).restart();
    return resourceType;
};

const getServiceObservedHealth = async (
    runtime: CloudflareTunnelRuntime,
): Promise<CloudflareTunnelRuntimeObservedHealth> => {
    const observedAt = now();

    try {
        const docker = await getRemoteDocker(runtime.serverId);
        const service = docker.getService(runtime.dockerResourceName);
        const inspect = await service.inspect();
        const tasks = await docker.listTasks({
            filters: JSON.stringify({
                service: [runtime.dockerResourceName],
            }),
        });

        const desiredReplicas = inspect.Spec?.Mode?.Replicated?.Replicas ?? 0;
        const runningTasks = tasks.filter(
            (task) =>
                task.DesiredState === "running" && task.Status?.State === "running",
        );
        const sortedTasks = [...tasks].sort((left, right) => {
            const leftTime = new Date(
                left.Status?.Timestamp || left.UpdatedAt || left.CreatedAt || 0,
            ).getTime();
            const rightTime = new Date(
                right.Status?.Timestamp || right.UpdatedAt || right.CreatedAt || 0,
            ).getTime();

            return rightTime - leftTime;
        });
        const latestTask = sortedTasks[0];
        const latestState = latestTask?.Status?.State || "unknown";
        const latestMessage =
            latestTask?.Status?.Err || latestTask?.Status?.Message || null;
        const runningCount = runningTasks.length;

        if (desiredReplicas === 0) {
            return {
                observedAt,
                status: "unhealthy",
                state: "scaled-down",
                message: "Service has 0 desired replicas.",
                desiredReplicas,
                runningTasks: runningCount,
                totalTasks: tasks.length,
                exitCode: latestTask?.Status?.ContainerStatus?.ExitCode ?? null,
            };
        }

        if (runningCount === 0) {
            return {
                observedAt,
                status: "unhealthy",
                state: latestState,
                message: latestMessage || "No running tasks were found for this service.",
                desiredReplicas,
                runningTasks: runningCount,
                totalTasks: tasks.length,
                exitCode: latestTask?.Status?.ContainerStatus?.ExitCode ?? null,
            };
        }

        if (runningCount < desiredReplicas || latestState !== "running") {
            return {
                observedAt,
                status: "degraded",
                state: latestState,
                message:
                    latestMessage ||
                    `Only ${runningCount}/${desiredReplicas} tasks are currently running.`,
                desiredReplicas,
                runningTasks: runningCount,
                totalTasks: tasks.length,
                exitCode: latestTask?.Status?.ContainerStatus?.ExitCode ?? null,
            };
        }

        return {
            observedAt,
            status: "healthy",
            state: latestState,
            message:
                tasks.length > runningCount
                    ? `${runningCount}/${desiredReplicas} running; older failed tasks exist in history.`
                    : null,
            desiredReplicas,
            runningTasks: runningCount,
            totalTasks: tasks.length,
            exitCode: latestTask?.Status?.ContainerStatus?.ExitCode ?? null,
        };
    } catch (error) {
        return {
            observedAt,
            status: "missing",
            state: "missing",
            message:
                error instanceof Error
                    ? error.message
                    : "Cloudflare shared runtime service was not found",
            desiredReplicas: null,
            runningTasks: null,
            totalTasks: null,
            exitCode: null,
        };
    }
};

const getStandaloneObservedHealth = async (
    runtime: CloudflareTunnelRuntime,
): Promise<CloudflareTunnelRuntimeObservedHealth> => {
    const observedAt = now();

    try {
        const docker = await getRemoteDocker(runtime.serverId);
        const inspect = await docker
            .getContainer(runtime.dockerResourceName)
            .inspect();
        const state = inspect.State?.Status || "unknown";
        const exitCode = inspect.State?.ExitCode ?? null;
        const errorMessage = inspect.State?.Error || null;

        if (inspect.State?.Running) {
            return {
                observedAt,
                status: state === "running" ? "healthy" : "degraded",
                state,
                message: errorMessage,
                desiredReplicas: 1,
                runningTasks: 1,
                totalTasks: 1,
                exitCode,
            };
        }

        return {
            observedAt,
            status: state === "restarting" ? "degraded" : "unhealthy",
            state,
            message: errorMessage || `Container is ${state}.`,
            desiredReplicas: 1,
            runningTasks: 0,
            totalTasks: 1,
            exitCode,
        };
    } catch (error) {
        return {
            observedAt,
            status: "missing",
            state: "missing",
            message:
                error instanceof Error
                    ? error.message
                    : "Cloudflare shared runtime container was not found",
            desiredReplicas: null,
            runningTasks: null,
            totalTasks: null,
            exitCode: null,
        };
    }
};

const getObservedRuntimeHealth = async (
    runtime: CloudflareTunnelRuntime,
    resourceType: "service" | "standalone" | "unknown",
) => {
    if (resourceType === "service") {
        return getServiceObservedHealth(runtime);
    }

    if (resourceType === "standalone") {
        return getStandaloneObservedHealth(runtime);
    }

    return {
        observedAt: now(),
        status: "missing" as const,
        state: "missing",
        message: "Cloudflare shared runtime resource was not found on the target server.",
        desiredReplicas: null,
        runningTasks: null,
        totalTasks: null,
        exitCode: null,
    };
};

const mapObservedHealthToRuntimeState = (
    observedHealth: CloudflareTunnelRuntimeObservedHealth,
) => {
    if (observedHealth.status === "missing") {
        return {
            status: "stopped" as const,
            lastError:
                observedHealth.message ||
                "Cloudflare shared runtime resource was not found on the target server.",
        };
    }

    if (observedHealth.status === "unhealthy") {
        return {
            status: "error" as const,
            lastError:
                observedHealth.message || "Cloudflare shared runtime is unhealthy.",
        };
    }

    return {
        status: "running" as const,
        lastError:
            observedHealth.status === "degraded"
                ? observedHealth.message
                : null,
    };
};

const isRuntimeDrifted = (
    runtime: Pick<
        SharedManagedCloudflareTunnelRuntimeSummary,
        "status" | "referenceCount" | "observedHealth"
    >,
) => {
    if (runtime.referenceCount === 0) {
        return false;
    }

    return (
        runtime.status !== "running" || runtime.observedHealth.status !== "healthy"
    );
};

const repairRuntimeResource = async (
    runtime: CloudflareTunnelRuntime,
    summary: SharedManagedCloudflareTunnelRuntimeSummary,
) => {
    if (
        summary.resourceType === "unknown" ||
        summary.observedHealth.status === "missing"
    ) {
        await ensureRuntimeResource(runtime);
        return "ensure" as const;
    }

    if (
        summary.resourceType === "standalone" &&
        ["created", "exited", "dead"].includes(summary.observedHealth.state)
    ) {
        await ensureRuntimeResource(runtime);
        return "start" as const;
    }

    await removeRuntimeResource(runtime);
    await ensureRuntimeResource(runtime);
    return "recreate" as const;
};

const countSharedManagedReferences = async ({
    cloudflareIntegrationId,
    cloudflareTunnelId,
    serverId,
    excludeDomainId,
}: {
    cloudflareIntegrationId: string;
    cloudflareTunnelId: string;
    serverId?: string | null;
    excludeDomainId?: string;
}) => {
    const results = await db.query.domains.findMany({
        where: and(
            eq(domains.publishToCloudflare, true),
            eq(domains.cloudflareTunnelMode, "shared-managed"),
            eq(domains.cloudflareIntegrationId, cloudflareIntegrationId),
            eq(domains.cloudflareTunnelId, cloudflareTunnelId),
            ...(excludeDomainId ? [ne(domains.domainId, excludeDomainId)] : []),
        ),
        columns: {
            domainId: true,
        },
        with: {
            application: {
                columns: {
                    serverId: true,
                },
            },
            compose: {
                columns: {
                    serverId: true,
                },
            },
        },
    });

    return results.filter((result) => {
        const resultServerId =
            result.application?.serverId ?? result.compose?.serverId ?? null;
        return resultServerId === (serverId ?? null);
    }).length;
};

const listRuntimeReferences = async (
    runtime: CloudflareTunnelRuntime,
): Promise<CloudflareTunnelRuntimeReference[]> => {
    const results = await db.query.domains.findMany({
        where: and(
            eq(domains.publishToCloudflare, true),
            eq(domains.cloudflareTunnelMode, "shared-managed"),
            eq(domains.cloudflareIntegrationId, runtime.cloudflareIntegrationId),
            eq(domains.cloudflareTunnelId, runtime.cloudflareTunnelId),
        ),
        columns: {
            domainId: true,
            host: true,
            path: true,
        },
        with: {
            application: {
                columns: {
                    serverId: true,
                },
            },
            compose: {
                columns: {
                    serverId: true,
                },
            },
        },
    });

    return results
        .filter((result) => {
            const resultServerId =
                result.application?.serverId ?? result.compose?.serverId ?? null;
            return resultServerId === (runtime.serverId ?? null);
        })
        .map((result) => ({
            domainId: result.domainId,
            host: result.host,
            path: result.path,
        }));
};

const buildRuntimeSummary = async (
    runtime: Awaited<ReturnType<typeof findRuntimeById>>,
): Promise<SharedManagedCloudflareTunnelRuntimeSummary> => {
    if (!runtime) {
        throw new TRPCError({
            code: "NOT_FOUND",
            message: "Cloudflare shared runtime not found",
        });
    }

    const references = await listRuntimeReferences(runtime);
    const resourceType = await getDockerResourceType(
        runtime.dockerResourceName,
        runtime.serverId || undefined,
    );
    const observedHealth = await getObservedRuntimeHealth(runtime, resourceType);

    return {
        ...runtime,
        resourceType,
        referenceCount: references.length,
        references,
        integrationName: runtime.cloudflareIntegration?.name || "Unknown integration",
        serverName: runtime.server?.name || null,
        observedHealth,
    };
};

export const ensureSharedManagedCloudflareTunnelRuntime = async ({
    organizationId,
    cloudflareIntegrationId,
    cloudflareTunnelId,
    cloudflareTunnelName,
    domain,
}: RuntimeScope & {
    cloudflareTunnelName: string;
    domain: DomainBinding;
}) => {
    const serverId = await resolveServerIdFromBinding(domain);
    let runtime = await findRuntimeByScope({
        organizationId,
        serverId,
        cloudflareIntegrationId,
        cloudflareTunnelId,
    });

    if (!runtime) {
        const runtimeId = nanoid();
        runtime = await db
            .insert(cloudflareTunnelRuntime)
            .values({
                cloudflareTunnelRuntimeId: runtimeId,
                organizationId,
                serverId,
                cloudflareIntegrationId,
                cloudflareTunnelId,
                cloudflareTunnelName,
                dockerResourceName: getSharedRuntimeResourceName(runtimeId),
                status: "pending",
                lastSeenAt: now(),
            } as typeof cloudflareTunnelRuntime.$inferInsert)
            .returning()
            .then((result) => result[0]);
    }

    if (!runtime) {
        throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Could not create a Cloudflare shared runtime record",
        });
    }

    try {
        await ensureRuntimeResource(runtime);
        return await updateRuntimeById(runtime.cloudflareTunnelRuntimeId, {
            cloudflareTunnelName,
            status: "running",
            lastError: null,
            lastStartedAt: runtime.lastStartedAt || now(),
            lastSeenAt: now(),
        });
    } catch (error) {
        await updateRuntimeById(runtime.cloudflareTunnelRuntimeId, {
            cloudflareTunnelName,
            status: "error",
            lastError:
                error instanceof Error
                    ? error.message
                    : "Unknown Cloudflare runtime error",
            lastSeenAt: now(),
        });
        throw error;
    }
};

export const listSharedManagedCloudflareTunnelRuntimes = async (
    organizationId: string,
) => {
    const runtimes = await db.query.cloudflareTunnelRuntime.findMany({
        where: eq(cloudflareTunnelRuntime.organizationId, organizationId),
    });

    const summaries = await Promise.all(
        runtimes.map(async (runtime) =>
            buildRuntimeSummary(
                await findRuntimeById(runtime.cloudflareTunnelRuntimeId),
            ),
        ),
    );

    return summaries.sort((left, right) => {
        if (left.integrationName !== right.integrationName) {
            return left.integrationName.localeCompare(right.integrationName);
        }

        if (left.cloudflareTunnelName !== right.cloudflareTunnelName) {
            return left.cloudflareTunnelName.localeCompare(right.cloudflareTunnelName);
        }

        return (left.serverName || "").localeCompare(right.serverName || "");
    });
};

export const reconcileSharedManagedCloudflareTunnelRuntime = async ({
    cloudflareTunnelRuntimeId,
    organizationId,
}: {
    cloudflareTunnelRuntimeId: string;
    organizationId?: string;
}) => {
    const runtime = await findRuntimeById(cloudflareTunnelRuntimeId);

    if (!runtime) {
        throw new TRPCError({
            code: "NOT_FOUND",
            message: "Cloudflare shared runtime not found",
        });
    }

    if (organizationId && runtime.organizationId !== organizationId) {
        throw new TRPCError({
            code: "UNAUTHORIZED",
            message:
                "You are not allowed to reconcile this Cloudflare shared runtime",
        });
    }

    const resourceType = await getDockerResourceType(
        runtime.dockerResourceName,
        runtime.serverId || undefined,
    );
    const observedHealth = await getObservedRuntimeHealth(runtime, resourceType);
    const nextState = mapObservedHealthToRuntimeState(observedHealth);
    const didStatusChange =
        runtime.status !== nextState.status ||
        runtime.lastError !== nextState.lastError;

    await updateRuntimeById(runtime.cloudflareTunnelRuntimeId, {
        status: nextState.status,
        lastError: nextState.lastError,
        lastSeenAt: observedHealth.observedAt,
        ...(nextState.status === "running" && runtime.status !== "running"
            ? {
                lastStartedAt: observedHealth.observedAt,
            }
            : {}),
    });

    return {
        changed: didStatusChange,
        summary: await buildRuntimeSummary(
            await findRuntimeById(runtime.cloudflareTunnelRuntimeId),
        ),
    };
};

export const reconcileAllSharedManagedCloudflareTunnelRuntimes = async (
    organizationId?: string,
): Promise<SharedManagedCloudflareTunnelRuntimeReconcileResult> => {
    const checkedAt = now();
    const runtimes = await db.query.cloudflareTunnelRuntime.findMany({
        ...(organizationId
            ? {
                where: eq(cloudflareTunnelRuntime.organizationId, organizationId),
            }
            : {}),
        columns: {
            cloudflareTunnelRuntimeId: true,
        },
    });

    let changedCount = 0;
    let failedCount = 0;

    for (const runtime of runtimes) {
        try {
            const result = await reconcileSharedManagedCloudflareTunnelRuntime(
                {
                    cloudflareTunnelRuntimeId: runtime.cloudflareTunnelRuntimeId,
                    organizationId,
                },
            );
            if (result.changed) {
                changedCount += 1;
            }
        } catch (error) {
            failedCount += 1;
            console.error(
                `[Cloudflare Runtime Reconcile] Failed for ${runtime.cloudflareTunnelRuntimeId}`,
                error,
            );
        }
    }

    return {
        checkedAt,
        reconciledCount: runtimes.length,
        changedCount,
        failedCount,
    };
};

export const repairSharedManagedCloudflareTunnelRuntime = async ({
    organizationId,
    cloudflareTunnelRuntimeId,
}: {
    organizationId: string;
    cloudflareTunnelRuntimeId: string;
}) => {
    const runtime = await findRuntimeById(cloudflareTunnelRuntimeId);

    if (!runtime || runtime.organizationId !== organizationId) {
        throw new TRPCError({
            code: "NOT_FOUND",
            message: "Cloudflare shared runtime not found",
        });
    }

    const summary = await buildRuntimeSummary(runtime);

    if (summary.referenceCount === 0) {
        throw new TRPCError({
            code: "BAD_REQUEST",
            message:
                "This shared runtime has no referenced domains. Clean it up instead of repairing it.",
        });
    }

    if (!isRuntimeDrifted(summary)) {
        return {
            changed: false,
            action: "noop" as const,
            summary,
        };
    }

    const action = await repairRuntimeResource(runtime, summary);
    const reconciled = await reconcileSharedManagedCloudflareTunnelRuntime(
        {
            cloudflareTunnelRuntimeId: runtime.cloudflareTunnelRuntimeId,
            organizationId,
        },
    );

    return {
        changed: true,
        action,
        summary: reconciled.summary,
    };
};

export const repairDriftedSharedManagedCloudflareTunnelRuntimes = async (
    organizationId: string,
): Promise<SharedManagedCloudflareTunnelRuntimeRepairResult> => {
    const checkedAt = now();
    const runtimes = await listSharedManagedCloudflareTunnelRuntimes(organizationId);
    const repairCandidates = runtimes.filter((runtime) => isRuntimeDrifted(runtime));

    let repairedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const runtime of repairCandidates) {
        try {
            const result = await repairSharedManagedCloudflareTunnelRuntime({
                organizationId,
                cloudflareTunnelRuntimeId: runtime.cloudflareTunnelRuntimeId,
            });

            if (result.changed) {
                repairedCount += 1;
            } else {
                skippedCount += 1;
            }
        } catch (error) {
            failedCount += 1;
            console.error(
                `[Cloudflare Runtime Repair] Failed for ${runtime.cloudflareTunnelRuntimeId}`,
                error,
            );
        }
    }

    return {
        checkedAt,
        attemptedCount: repairCandidates.length,
        repairedCount,
        skippedCount,
        failedCount,
    };
};

export const initCloudflareTunnelRuntimeReconcileJob = async (
    cronExpression = SHARED_RUNTIME_RECONCILE_CRON,
) => {
    const existingJob = scheduledJobs[SHARED_RUNTIME_RECONCILE_JOB_NAME];
    if (existingJob) {
        existingJob.cancel();
    }

    scheduleJob(
        SHARED_RUNTIME_RECONCILE_JOB_NAME,
        cronExpression,
        async () => {
            try {
                const result =
                    await reconcileAllSharedManagedCloudflareTunnelRuntimes();

                if (result.reconciledCount > 0 || result.failedCount > 0) {
                    console.log(
                        `[Cloudflare Runtime Reconcile] Checked ${result.reconciledCount} runtimes, changed ${result.changedCount}, failed ${result.failedCount}`,
                    );
                }
            } catch (error) {
                console.error(
                    "[Cloudflare Runtime Reconcile] Background reconcile failed",
                    error,
                );
            }
        },
    );

    return true;
};

export const restartSharedManagedCloudflareTunnelRuntime = async ({
    organizationId,
    cloudflareTunnelRuntimeId,
}: {
    organizationId: string;
    cloudflareTunnelRuntimeId: string;
}) => {
    const runtime = await findRuntimeById(cloudflareTunnelRuntimeId);

    if (!runtime || runtime.organizationId !== organizationId) {
        throw new TRPCError({
            code: "NOT_FOUND",
            message: "Cloudflare shared runtime not found",
        });
    }

    try {
        await restartRuntimeResource(runtime);
        await updateRuntimeById(runtime.cloudflareTunnelRuntimeId, {
            status: "running",
            lastError: null,
            lastStartedAt: now(),
            lastSeenAt: now(),
        });
    } catch (error) {
        await updateRuntimeById(runtime.cloudflareTunnelRuntimeId, {
            status: "error",
            lastError:
                error instanceof Error
                    ? error.message
                    : "Failed to restart Cloudflare shared runtime",
            lastSeenAt: now(),
        });
        throw error;
    }

    return buildRuntimeSummary(await findRuntimeById(cloudflareTunnelRuntimeId));
};

export const recreateSharedManagedCloudflareTunnelRuntime = async ({
    organizationId,
    cloudflareTunnelRuntimeId,
}: {
    organizationId: string;
    cloudflareTunnelRuntimeId: string;
}) => {
    const runtime = await findRuntimeById(cloudflareTunnelRuntimeId);

    if (!runtime || runtime.organizationId !== organizationId) {
        throw new TRPCError({
            code: "NOT_FOUND",
            message: "Cloudflare shared runtime not found",
        });
    }

    try {
        await removeRuntimeResource(runtime);
        await ensureRuntimeResource(runtime);
        await updateRuntimeById(runtime.cloudflareTunnelRuntimeId, {
            status: "running",
            lastError: null,
            lastStartedAt: now(),
            lastSeenAt: now(),
        });
    } catch (error) {
        await updateRuntimeById(runtime.cloudflareTunnelRuntimeId, {
            status: "error",
            lastError:
                error instanceof Error
                    ? error.message
                    : "Failed to recreate Cloudflare shared runtime",
            lastSeenAt: now(),
        });
        throw error;
    }

    return buildRuntimeSummary(await findRuntimeById(cloudflareTunnelRuntimeId));
};

export const cleanupUnusedSharedManagedCloudflareTunnelRuntimes = async (
    organizationId: string,
) => {
    const runtimes = await listSharedManagedCloudflareTunnelRuntimes(organizationId);
    const cleanedRuntimeIds: string[] = [];

    for (const runtime of runtimes) {
        if (runtime.referenceCount > 0) {
            continue;
        }

        await removeRuntimeResource(runtime);
        await removeRuntimeById(runtime.cloudflareTunnelRuntimeId);
        cleanedRuntimeIds.push(runtime.cloudflareTunnelRuntimeId);
    }

    return {
        cleanedRuntimeIds,
        cleanedCount: cleanedRuntimeIds.length,
    };
};

export const releaseSharedManagedCloudflareTunnelRuntime = async (
    domain: DomainBinding,
) => {
    if (
        domain.cloudflareTunnelMode !== "shared-managed" ||
        !domain.cloudflareIntegrationId
    ) {
        return;
    }

    const integration = await findCloudflareIntegrationById(
        domain.cloudflareIntegrationId,
    ).catch(() => null);

    if (!integration) {
        return;
    }

    const tunnelId = domain.cloudflareTunnelId || integration.defaultTunnelId;
    if (!tunnelId) {
        return;
    }

    const serverId = await resolveServerIdFromBinding(domain);
    const runtime = await findRuntimeByScope({
        organizationId: integration.organizationId,
        serverId,
        cloudflareIntegrationId: integration.cloudflareIntegrationId,
        cloudflareTunnelId: tunnelId,
    });

    if (!runtime) {
        return;
    }

    const references = await countSharedManagedReferences({
        cloudflareIntegrationId: integration.cloudflareIntegrationId,
        cloudflareTunnelId: tunnelId,
        serverId,
        excludeDomainId: domain.domainId,
    });

    if (references > 0) {
        await updateRuntimeById(runtime.cloudflareTunnelRuntimeId, {
            status: "running",
            lastSeenAt: now(),
            lastError: null,
        });
        return;
    }

    await removeRuntimeResource(runtime);

    await removeRuntimeById(runtime.cloudflareTunnelRuntimeId);
};
