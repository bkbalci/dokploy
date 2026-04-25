import { db } from "@dokploy/server/db";
import { cloudflareTunnelRuntime, domains } from "@dokploy/server/db/schema";
import { getDockerResourceType } from "@dokploy/server/services/settings";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { TRPCError } from "@trpc/server";
import type { ContainerCreateOptions, CreateServiceOptions } from "dockerode";
import { and, eq, isNull, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { findApplicationById } from "./application";
import {
    findCloudflareIntegrationById,
    getCloudflareTunnelToken,
} from "./cloudflare";
import { findComposeById } from "./compose";

const CLOUDFLARED_IMAGE = "cloudflare/cloudflared:latest";
const DOKPLOY_NETWORK = "dokploy-network";
const TRAEFIK_RESOURCE_NAME = "dokploy-traefik";

export type CloudflareTunnelRuntime =
    typeof cloudflareTunnelRuntime.$inferSelect;

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

    await removeRuntimeById(runtime.cloudflareTunnelRuntimeId);
};
