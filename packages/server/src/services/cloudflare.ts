import { db } from "@dokploy/server/db";
import { cloudflareIntegration } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import type {
    ApiCreateCloudflareIntegration,
    ApiTestCloudflareConnection,
} from "../db/schema";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DOKPLOY_CLOUDFLARE_COMMENT_PREFIX = "Managed by Dokploy Cloudflare Tunnel";
const DOKPLOY_CLOUDFLARE_TUNNEL_NAME_PREFIX = "dokploy-sidecar-";

interface CloudflareApiError {
    message?: string;
}

interface CloudflareApiResponse<T> {
    success: boolean;
    errors?: CloudflareApiError[];
    messages?: CloudflareApiError[];
    result: T;
}

interface CloudflareTokenVerification {
    id: string;
    status: string;
}

interface CloudflareZone {
    id: string;
    name: string;
    status: string;
    account?: {
        id?: string;
        name?: string;
    };
}

interface CloudflareTunnel {
    id: string;
    name: string;
    status: string;
    metadata?: Record<string, unknown> | null;
    conns_active_at?: string | null;
    conns_inactive_at?: string | null;
    connections?: Array<{
        opened_at?: string;
    }>;
}

type CloudflareTunnelSummary = {
    id: string;
    name: string;
    status: string;
    connectionCount: number;
    lastActiveAt: string | null;
    lastInactiveAt: string | null;
    isDokployManaged: boolean;
};

interface CloudflareTunnelIngressRule {
    hostname?: string;
    service: string;
    path?: string;
    originRequest?: Record<string, unknown>;
    [key: string]: unknown;
}

interface CloudflareTunnelConfigurationResult {
    account_id?: string;
    config?: {
        ingress?: CloudflareTunnelIngressRule[];
        originRequest?: Record<string, unknown>;
        ["warp-routing"]?: {
            enabled?: boolean;
        };
        [key: string]: unknown;
    };
    created_at?: string;
    source?: "local" | "cloudflare";
    tunnel_id?: string;
    version?: number;
}

interface CloudflareDnsRecord {
    id: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
    comment?: string | null;
}

export type CloudflareIntegration = typeof cloudflareIntegration.$inferSelect;
export interface CloudflareZoneMatch {
    id: string;
    name: string;
}

const getCloudflareErrorMessage = (data: {
    errors?: CloudflareApiError[];
    messages?: CloudflareApiError[];
}) => {
    return (
        data.errors?.map((error) => error.message).filter(Boolean).join(", ") ||
        data.messages?.map((message) => message.message).filter(Boolean).join(", ") ||
        "Cloudflare request failed"
    );
};

type CloudflareUserFacingErrorContext = {
    action?: "create-tunnel" | "publish-domain" | "repair-domain";
    step?:
    | "select-tunnel"
    | "shared-runtime"
    | "resolve-zone"
    | "resolve-origin"
    | "update-ingress"
    | "update-dns"
    | "delete-ingress"
    | "delete-dns";
    hostname?: string | null;
    cloudflareTunnelMode?:
    | "existing-instance"
    | "sidecar"
    | "shared-managed"
    | null;
    tunnelName?: string | null;
    serviceName?: string | null;
    port?: number | null;
};

const getCloudflareUnknownErrorMessage = (error: unknown) => {
    if (error instanceof TRPCError) {
        return error.message;
    }

    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
};

const getCloudflareFallbackMessage = (
    context: CloudflareUserFacingErrorContext,
) => {
    const hostname = context.hostname ? `'${context.hostname}'` : "this hostname";

    switch (context.step) {
        case "select-tunnel":
            return "Dokploy could not load the selected Cloudflare tunnel. Re-select the tunnel or verify the integration account access.";
        case "shared-runtime":
        case "resolve-origin":
            if (context.cloudflareTunnelMode === "sidecar") {
                return "Dokploy could not prepare the sidecar origin for this domain. Check the compose service and container port settings.";
            }

            if (context.cloudflareTunnelMode === "shared-managed") {
                return "Dokploy could not prepare the shared-managed origin. Ensure Dokploy Traefik is running on the target server first.";
            }

            return "Dokploy could not determine the origin server for this domain. Check the service server assignment or the global Web Server IP.";
        case "resolve-zone":
            return `Dokploy could not find a matching Cloudflare zone for ${hostname}.`;
        case "update-ingress":
            return "Cloudflare could not update the tunnel ingress for this domain.";
        case "update-dns":
            return "Cloudflare could not update the DNS record for this domain.";
        case "delete-ingress":
            return "Cloudflare could not remove the tunnel ingress for this domain.";
        case "delete-dns":
            return "Cloudflare could not remove the DNS record for this domain.";
        default:
            if (context.action === "create-tunnel") {
                return "Cloudflare could not create the dedicated tunnel.";
            }

            if (context.action === "repair-domain") {
                return "Dokploy could not repair the Cloudflare configuration for this domain.";
            }

            return "Dokploy could not publish this domain through Cloudflare Tunnel.";
    }
};

export const toUserFacingCloudflareError = (
    error: unknown,
    context: CloudflareUserFacingErrorContext = {},
) => {
    if (
        error instanceof TRPCError &&
        error.code === "UNAUTHORIZED" &&
        error.message === "You are not allowed to use this Cloudflare integration"
    ) {
        return error;
    }

    const originalMessage = getCloudflareUnknownErrorMessage(error).trim();
    const lowerMessage = originalMessage.toLowerCase();

    let message = originalMessage;

    if (originalMessage.includes("Select a Cloudflare tunnel for this domain")) {
        message =
            "No Cloudflare tunnel is selected for this domain. Choose a tunnel here or set a default tunnel on the selected integration.";
    } else if (
        originalMessage.includes(
            "Cloudflare sidecar mode is currently supported for compose services only",
        )
    ) {
        message =
            "Cloudflare sidecar mode currently works only for compose services. Use an existing or shared-managed tunnel for app domains, or move this domain to a compose service.";
    } else if (
        originalMessage.includes(
            "A compose service name is required before Dokploy can create a Cloudflare sidecar",
        )
    ) {
        message =
            "Sidecar origin is incomplete. Select the compose service that should receive this traffic before saving.";
    } else if (
        originalMessage.includes(
            "A container port is required before Dokploy can create a Cloudflare sidecar",
        )
    ) {
        message =
            "Sidecar origin is incomplete. Select the container port that should receive this traffic before saving.";
    } else if (
        originalMessage.includes(
            "Cloudflare Tunnel publish does not support custom Traefik entrypoints yet",
        )
    ) {
        message =
            "Cloudflare publish cannot use a custom Traefik entrypoint yet. Switch back to Dokploy's default HTTP/HTTPS entrypoints or disable Cloudflare publish for this domain.";
    } else if (
        originalMessage.includes(
            "A server IP is required before Dokploy can publish this domain through Cloudflare Tunnel",
        )
    ) {
        message =
            "Dokploy cannot determine which server should receive this tunnel traffic. Attach the service to a server or configure the global Web Server IP before publishing through Cloudflare.";
    } else if (
        originalMessage.includes(
            "Dokploy Traefik runtime was not found on the selected server",
        )
    ) {
        message =
            "Shared-managed tunnel setup cannot continue because Dokploy Traefik is not running on the target server. Start or repair Traefik on that server first.";
    } else if (originalMessage.includes("No Cloudflare zone matches")) {
        const hostname = context.hostname || "this hostname";
        message = `Cloudflare could not find a zone for '${hostname}'. Use a hostname that belongs to a zone in the selected account, or switch to another Cloudflare integration.`;
    } else if (
        originalMessage.includes("already exists and is not managed by Dokploy")
    ) {
        message =
            "Cloudflare already has a DNS record for this hostname that Dokploy does not manage. Remove or update that record manually, or choose a different hostname.";
    } else if (
        originalMessage.includes("is not managed by Dokploy") &&
        originalMessage.includes("Cloudflare DNS record")
    ) {
        message =
            "Dokploy will not modify this Cloudflare DNS record because it is not marked as Dokploy-managed.";
    } else if (
        originalMessage.includes("was not found in the selected account") &&
        originalMessage.includes("Cloudflare tunnel")
    ) {
        message =
            "The selected Cloudflare tunnel is no longer available in this account. Re-select a tunnel or verify that the integration Account ID and token point to the same Cloudflare account.";
    } else if (
        context.action === "create-tunnel" &&
        lowerMessage.includes("already exists")
    ) {
        message =
            "A Cloudflare tunnel with this name already exists. Use a different name or reuse the existing tunnel instead of creating a new one.";
    } else if (
        lowerMessage.includes("authentication") ||
        lowerMessage.includes("unauthorized") ||
        lowerMessage.includes("forbidden") ||
        lowerMessage.includes("permission denied") ||
        lowerMessage.includes("invalid request headers")
    ) {
        message =
            context.action === "create-tunnel"
                ? "Cloudflare rejected the tunnel request. Verify that the API token has tunnel permissions and that the Account ID belongs to the same Cloudflare account as the token."
                : "Cloudflare rejected this request. Verify the API token scopes, the Account ID, and that the selected zone and tunnel belong to the same Cloudflare account.";
    } else if (
        lowerMessage.includes("fetch failed") ||
        lowerMessage.includes("econnreset") ||
        lowerMessage.includes("enotfound") ||
        lowerMessage.includes("network")
    ) {
        message =
            "Dokploy could not reach the Cloudflare API. Check outbound network connectivity from the server and try again.";
    } else if (!originalMessage || originalMessage === "Cloudflare request failed") {
        message = getCloudflareFallbackMessage(context);
    }

    return new TRPCError({
        code: error instanceof TRPCError ? error.code : "BAD_REQUEST",
        message: message || getCloudflareFallbackMessage(context),
        cause: error instanceof Error ? error : undefined,
    });
};

const normalizeCloudflarePath = (path?: string | null) => {
    if (!path || path === "/") {
        return null;
    }

    return path;
};

const buildDokployCloudflareComment = (domainId: string) => {
    return `${DOKPLOY_CLOUDFLARE_COMMENT_PREFIX} (domain:${domainId})`;
};

const normalizeDokployTunnelName = (name: string) => {
    const cleanedName = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-\s]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

    const baseName = cleanedName || "tunnel";

    return baseName.startsWith(DOKPLOY_CLOUDFLARE_TUNNEL_NAME_PREFIX)
        ? baseName
        : `${DOKPLOY_CLOUDFLARE_TUNNEL_NAME_PREFIX}${baseName}`;
};

const mapCloudflareTunnel = (tunnel: CloudflareTunnel): CloudflareTunnelSummary => ({
    id: tunnel.id,
    name: tunnel.name,
    status: tunnel.status,
    connectionCount: tunnel.connections?.length ?? 0,
    lastActiveAt: tunnel.conns_active_at ?? null,
    lastInactiveAt: tunnel.conns_inactive_at ?? null,
    isDokployManaged: tunnel.name.startsWith(
        DOKPLOY_CLOUDFLARE_TUNNEL_NAME_PREFIX,
    ),
});

const isDokployManagedDnsRecord = (
    record: Pick<CloudflareDnsRecord, "comment">,
    domainId?: string,
) => {
    if (!record.comment?.includes(DOKPLOY_CLOUDFLARE_COMMENT_PREFIX)) {
        return false;
    }

    if (!domainId) {
        return true;
    }

    return record.comment.includes(`domain:${domainId}`);
};

const matchesIngressRule = (
    rule: CloudflareTunnelIngressRule,
    hostname: string,
    path?: string | null,
) => {
    return (
        rule.hostname === hostname &&
        normalizeCloudflarePath(rule.path) === normalizeCloudflarePath(path)
    );
};

const isCatchAllIngressRule = (rule: CloudflareTunnelIngressRule) => {
    return !rule.hostname && rule.service.startsWith("http_status:");
};

const cloudflareRequest = async <T>(
    path: string,
    apiToken: string,
    init?: RequestInit,
) => {
    const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
            ...(init?.headers ?? {}),
        },
    });

    const data = (await response.json()) as CloudflareApiResponse<T>;

    if (!response.ok || !data.success) {
        throw new Error(getCloudflareErrorMessage(data));
    }

    return data.result;
};

export const listCloudflareZones = async (apiToken: string) => {
    const zones = await cloudflareRequest<CloudflareZone[]>(
        "/zones?per_page=100",
        apiToken,
    );

    return zones
        .map((zone) => ({
            id: zone.id,
            name: zone.name,
            status: zone.status,
            accountId: zone.account?.id ?? null,
            accountName: zone.account?.name ?? null,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
};

export const listCloudflareTunnels = async (
    apiToken: string,
    accountId: string,
) => {
    const tunnels = await cloudflareRequest<CloudflareTunnel[]>(
        `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100`,
        apiToken,
    );

    return tunnels
        .map(mapCloudflareTunnel)
        .sort((left, right) => left.name.localeCompare(right.name));
};

export const createCloudflareTunnel = async ({
    apiToken,
    accountId,
    name,
}: {
    apiToken: string;
    accountId: string;
    name: string;
}) => {
    const tunnel = await cloudflareRequest<CloudflareTunnel>(
        `/accounts/${accountId}/cfd_tunnel`,
        apiToken,
        {
            method: "POST",
            body: JSON.stringify({
                name: normalizeDokployTunnelName(name),
                config_src: "cloudflare",
            }),
        },
    );

    return mapCloudflareTunnel(tunnel);
};

export const findCloudflareTunnelById = async ({
    apiToken,
    accountId,
    tunnelId,
}: {
    apiToken: string;
    accountId: string;
    tunnelId: string;
}) => {
    const tunnels = await listCloudflareTunnels(apiToken, accountId);
    const tunnel = tunnels.find((item) => item.id === tunnelId);

    if (!tunnel) {
        throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cloudflare tunnel '${tunnelId}' was not found in the selected account`,
        });
    }

    return tunnel;
};

export const findCloudflareDnsRecord = async (
    apiToken: string,
    zoneId: string,
    hostname: string,
) => {
    const query = new URLSearchParams({
        type: "CNAME",
        name: hostname,
    });

    const records = await cloudflareRequest<CloudflareDnsRecord[]>(
        `/zones/${zoneId}/dns_records?${query.toString()}`,
        apiToken,
    );

    return records.find((record) => record.name === hostname) ?? null;
};

const putCloudflareTunnelConfiguration = async ({
    apiToken,
    accountId,
    tunnelId,
    configuration,
    version,
}: {
    apiToken: string;
    accountId: string;
    tunnelId: string;
    configuration: NonNullable<CloudflareTunnelConfigurationResult["config"]>;
    version?: number;
}) => {
    return cloudflareRequest<CloudflareTunnelConfigurationResult>(
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
        apiToken,
        {
            method: "PUT",
            body: JSON.stringify({
                config: configuration,
                source: "cloudflare",
                ...(typeof version === "number" ? { version } : {}),
            }),
        },
    );
};

export const findCloudflareZoneForHostname = async ({
    apiToken,
    hostname,
    preferredZoneId,
    preferredZoneName,
}: {
    apiToken: string;
    hostname: string;
    preferredZoneId?: string | null;
    preferredZoneName?: string | null;
}): Promise<CloudflareZoneMatch> => {
    const zones = await listCloudflareZones(apiToken);
    const normalizedHost = hostname.toLowerCase();
    const matchedZones = zones
        .filter(
            (zone) =>
                normalizedHost === zone.name.toLowerCase() ||
                normalizedHost.endsWith(`.${zone.name.toLowerCase()}`),
        )
        .sort((left, right) => right.name.length - left.name.length);

    if (preferredZoneId || preferredZoneName) {
        const preferredZone = matchedZones.find(
            (zone) =>
                (preferredZoneId && zone.id === preferredZoneId) ||
                (preferredZoneName && zone.name === preferredZoneName),
        );

        if (preferredZone) {
            return {
                id: preferredZone.id,
                name: preferredZone.name,
            };
        }
    }

    const matchedZone = matchedZones[0];
    if (!matchedZone) {
        throw new TRPCError({
            code: "BAD_REQUEST",
            message: `No Cloudflare zone matches '${hostname}'`,
        });
    }

    return {
        id: matchedZone.id,
        name: matchedZone.name,
    };
};

export const getCloudflareTunnelConfiguration = async ({
    apiToken,
    accountId,
    tunnelId,
}: {
    apiToken: string;
    accountId: string;
    tunnelId: string;
}) => {
    return cloudflareRequest<CloudflareTunnelConfigurationResult>(
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
        apiToken,
    );
};

export const getCloudflareTunnelToken = async ({
    apiToken,
    accountId,
    tunnelId,
}: {
    apiToken: string;
    accountId: string;
    tunnelId: string;
}) => {
    return cloudflareRequest<string>(
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
        apiToken,
    );
};

export const upsertCloudflareTunnelIngress = async ({
    apiToken,
    accountId,
    tunnelId,
    hostname,
    path,
    service,
    originRequest,
}: {
    apiToken: string;
    accountId: string;
    tunnelId: string;
    hostname: string;
    path?: string | null;
    service: string;
    originRequest?: Record<string, unknown>;
}) => {
    const currentConfiguration = await getCloudflareTunnelConfiguration({
        apiToken,
        accountId,
        tunnelId,
    });

    const currentIngress = currentConfiguration.config?.ingress ?? [];
    const otherIngressRules = currentIngress.filter(
        (rule) => !matchesIngressRule(rule, hostname, path) && !isCatchAllIngressRule(rule),
    );
    const catchAllRules = currentIngress.filter(isCatchAllIngressRule);

    const nextIngressRule: CloudflareTunnelIngressRule = {
        hostname,
        service,
        ...(normalizeCloudflarePath(path)
            ? { path: normalizeCloudflarePath(path) || undefined }
            : {}),
        ...(originRequest ? { originRequest } : {}),
    };

    const ingress = [
        ...otherIngressRules,
        nextIngressRule,
        ...(catchAllRules.length > 0
            ? catchAllRules
            : [{ service: "http_status:404" } satisfies CloudflareTunnelIngressRule]),
    ];

    await putCloudflareTunnelConfiguration({
        apiToken,
        accountId,
        tunnelId,
        configuration: {
            ...(currentConfiguration.config ?? {}),
            ingress,
        },
        version: currentConfiguration.version,
    });
};

export const removeCloudflareTunnelIngress = async ({
    apiToken,
    accountId,
    tunnelId,
    hostname,
    path,
}: {
    apiToken: string;
    accountId: string;
    tunnelId: string;
    hostname: string;
    path?: string | null;
}) => {
    const currentConfiguration = await getCloudflareTunnelConfiguration({
        apiToken,
        accountId,
        tunnelId,
    });

    const currentIngress = currentConfiguration.config?.ingress ?? [];
    const filteredIngress = currentIngress.filter(
        (rule) => !matchesIngressRule(rule, hostname, path),
    );

    if (filteredIngress.length === currentIngress.length) {
        return;
    }

    const ingress = filteredIngress.length
        ? filteredIngress
        : [{ service: "http_status:404" } satisfies CloudflareTunnelIngressRule];

    await putCloudflareTunnelConfiguration({
        apiToken,
        accountId,
        tunnelId,
        configuration: {
            ...(currentConfiguration.config ?? {}),
            ingress,
        },
        version: currentConfiguration.version,
    });
};

export const upsertCloudflareDnsRecord = async ({
    apiToken,
    zoneId,
    hostname,
    tunnelId,
    domainId,
    existingDnsRecordId,
}: {
    apiToken: string;
    zoneId: string;
    hostname: string;
    tunnelId: string;
    domainId: string;
    existingDnsRecordId?: string | null;
}) => {
    const target = `${tunnelId}.cfargotunnel.com`;
    const comment = buildDokployCloudflareComment(domainId);

    let existingRecord = existingDnsRecordId
        ? await cloudflareRequest<CloudflareDnsRecord>(
            `/zones/${zoneId}/dns_records/${existingDnsRecordId}`,
            apiToken,
        ).catch(() => null)
        : null;

    if (!existingRecord) {
        existingRecord = await findCloudflareDnsRecord(apiToken, zoneId, hostname);
    }

    if (existingRecord) {
        if (
            existingRecord.id !== existingDnsRecordId &&
            !isDokployManagedDnsRecord(existingRecord, domainId)
        ) {
            throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Cloudflare DNS record '${hostname}' already exists and is not managed by Dokploy`,
            });
        }

        return cloudflareRequest<CloudflareDnsRecord>(
            `/zones/${zoneId}/dns_records/${existingRecord.id}`,
            apiToken,
            {
                method: "PATCH",
                body: JSON.stringify({
                    type: "CNAME",
                    name: hostname,
                    content: target,
                    proxied: true,
                    comment,
                }),
            },
        );
    }

    return cloudflareRequest<CloudflareDnsRecord>(
        `/zones/${zoneId}/dns_records`,
        apiToken,
        {
            method: "POST",
            body: JSON.stringify({
                type: "CNAME",
                name: hostname,
                content: target,
                proxied: true,
                comment,
            }),
        },
    );
};

export const removeCloudflareDnsRecord = async ({
    apiToken,
    zoneId,
    hostname,
    domainId,
    dnsRecordId,
}: {
    apiToken: string;
    zoneId: string;
    hostname: string;
    domainId: string;
    dnsRecordId?: string | null;
}) => {
    let record = dnsRecordId
        ? await cloudflareRequest<CloudflareDnsRecord>(
            `/zones/${zoneId}/dns_records/${dnsRecordId}`,
            apiToken,
        ).catch(() => null)
        : null;

    if (!record) {
        record = await findCloudflareDnsRecord(apiToken, zoneId, hostname);
    }

    if (!record) {
        return;
    }

    if (!isDokployManagedDnsRecord(record, domainId)) {
        throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cloudflare DNS record '${hostname}' is not managed by Dokploy`,
        });
    }

    await cloudflareRequest<{ id: string }>(
        `/zones/${zoneId}/dns_records/${record.id}`,
        apiToken,
        {
            method: "DELETE",
        },
    );
};

export const testCloudflareConnection = async (
    input: ApiTestCloudflareConnection,
) => {
    const zones = await listCloudflareZones(input.apiToken).catch((error) => {
        throw new TRPCError({
            code: "BAD_REQUEST",
            message:
                error instanceof Error
                    ? `Cloudflare token is valid, but listing zones failed. Check that the token has Zone Read on the target zone or account. Original error: ${error.message}`
                    : "Cloudflare token is valid, but listing zones failed",
        });
    });

    const tunnels = await listCloudflareTunnels(
        input.apiToken,
        input.accountId,
    ).catch((error) => {
        throw new TRPCError({
            code: "BAD_REQUEST",
            message:
                error instanceof Error
                    ? `Cloudflare token is valid, but listing tunnels for account '${input.accountId}' failed. Check that the Account ID matches the token scope and that the token has a tunnel or connector permission. Original error: ${error.message}`
                    : "Cloudflare token is valid, but listing tunnels failed",
        });
    });

    const verification = await cloudflareRequest<CloudflareTokenVerification>(
        "/user/tokens/verify",
        input.apiToken,
    ).catch(() => null);

    return {
        accountId: input.accountId,
        tokenStatus: verification?.status ?? "resource access confirmed",
        zones,
        tunnels,
    };
};

export const createCloudflareIntegration = async (
    input: ApiCreateCloudflareIntegration,
    organizationId: string,
    userId: string,
) => {
    const [result] = await db
        .insert(cloudflareIntegration)
        .values({
            ...input,
            organizationId,
            userId,
        })
        .returning();

    if (!result) {
        throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Error creating Cloudflare integration",
        });
    }

    return result;
};

export const findCloudflareIntegrationById = async (
    cloudflareIntegrationId: string,
) => {
    const result = await db.query.cloudflareIntegration.findFirst({
        where: eq(
            cloudflareIntegration.cloudflareIntegrationId,
            cloudflareIntegrationId,
        ),
    });

    if (!result) {
        throw new TRPCError({
            code: "NOT_FOUND",
            message: "Cloudflare integration not found",
        });
    }

    return result;
};

export const listCloudflareIntegrationsByOrganizationId = async (
    organizationId: string,
) => {
    return await db.query.cloudflareIntegration.findMany({
        where: eq(cloudflareIntegration.organizationId, organizationId),
        orderBy: [desc(cloudflareIntegration.createdAt)],
    });
};

export const updateCloudflareIntegration = async (
    cloudflareIntegrationId: string,
    input: Partial<CloudflareIntegration>,
) => {
    const [result] = await db
        .update(cloudflareIntegration)
        .set({
            ...input,
            updatedAt: new Date(),
        })
        .where(
            eq(
                cloudflareIntegration.cloudflareIntegrationId,
                cloudflareIntegrationId,
            ),
        )
        .returning();

    return result;
};

export const removeCloudflareIntegration = async (
    cloudflareIntegrationId: string,
) => {
    const [result] = await db
        .delete(cloudflareIntegration)
        .where(
            eq(
                cloudflareIntegration.cloudflareIntegrationId,
                cloudflareIntegrationId,
            ),
        )
        .returning();

    return result;
};