import dns from "node:dns";
import { promisify } from "node:util";
import { db } from "@dokploy/server/db";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { generateRandomDomain } from "@dokploy/server/templates";
import {
	manageDomain,
	removeDomain as removeTraefikDomain,
} from "@dokploy/server/utils/traefik/domain";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { type apiCreateDomain, domains } from "../db/schema";
import { findApplicationById } from "./application";
import { detectCDNProvider } from "./cdn";
import {
	findCloudflareIntegrationById,
	findCloudflareZoneForHostname,
	removeCloudflareDnsRecord,
	removeCloudflareTunnelIngress,
	upsertCloudflareDnsRecord,
	upsertCloudflareTunnelIngress,
} from "./cloudflare";
import { findComposeById } from "./compose";
import { findServerById } from "./server";

export type Domain = typeof domains.$inferSelect;

const clearCloudflareFields = (): Partial<Domain> => ({
	publishToCloudflare: false,
	cloudflareIntegrationId: null,
	cloudflareZoneId: null,
	cloudflareZoneName: null,
	cloudflareTunnelId: null,
	cloudflareTunnelName: null,
	cloudflareDnsRecordId: null,
});

const normalizeDomainPath = (path?: string | null) => {
	if (!path || path === "/") {
		return null;
	}

	return path;
};

const hasCloudflareBindingChanged = (
	currentDomain: Domain,
	nextDomain: Domain,
	nextTunnelId: string,
) => {
	return (
		currentDomain.host !== nextDomain.host ||
		normalizeDomainPath(currentDomain.path) !==
		normalizeDomainPath(nextDomain.path) ||
		currentDomain.https !== nextDomain.https ||
		currentDomain.cloudflareIntegrationId !==
		nextDomain.cloudflareIntegrationId ||
		currentDomain.cloudflareTunnelId !== nextTunnelId ||
		!nextDomain.publishToCloudflare
	);
};

const getCloudflareOriginService = async (domain: Domain) => {
	if (domain.customEntrypoint) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Cloudflare Tunnel publish does not support custom Traefik entrypoints yet",
		});
	}

	let serverIp = "";

	if (domain.applicationId) {
		const application = await findApplicationById(domain.applicationId);
		serverIp = application.server?.ipAddress?.toString() || "";
	} else if (domain.composeId) {
		const compose = await findComposeById(domain.composeId);
		serverIp = compose.server?.ipAddress?.toString() || "";
	}

	if (!serverIp) {
		const settings = await getWebServerSettings();
		serverIp = settings?.serverIp || "";
	}

	if (!serverIp) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"A server IP is required before Dokploy can publish this domain through Cloudflare Tunnel",
		});
	}

	if (domain.https) {
		return {
			service: `https://${serverIp}:443`,
			originRequest: {
				noTLSVerify: true,
			},
		};
	}

	return {
		service: `http://${serverIp}:80`,
		originRequest: undefined,
	};
};

export const removeCloudflareDomainSync = async (domain: Domain) => {
	if (!domain.publishToCloudflare || !domain.cloudflareIntegrationId) {
		return;
	}

	const integration = await findCloudflareIntegrationById(
		domain.cloudflareIntegrationId,
	).catch(() => null);

	if (!integration) {
		return;
	}

	const tunnelId = domain.cloudflareTunnelId || integration.defaultTunnelId;
	if (tunnelId) {
		await removeCloudflareTunnelIngress({
			apiToken: integration.apiToken,
			accountId: integration.accountId,
			tunnelId,
			hostname: domain.host,
			path: domain.path,
		});
	}

	const zoneId =
		domain.cloudflareZoneId ||
		(
			await findCloudflareZoneForHostname({
				apiToken: integration.apiToken,
				hostname: domain.host,
				preferredZoneId: integration.defaultZoneId,
				preferredZoneName: integration.defaultZoneName,
			})
		).id;

	await removeCloudflareDnsRecord({
		apiToken: integration.apiToken,
		zoneId,
		hostname: domain.host,
		domainId: domain.domainId,
		dnsRecordId: domain.cloudflareDnsRecordId,
	});
};

export const syncCloudflareDomain = async (
	nextDomain: Domain,
	currentDomain?: Domain,
) => {
	if (!nextDomain.publishToCloudflare || !nextDomain.cloudflareIntegrationId) {
		if (currentDomain?.publishToCloudflare) {
			await removeCloudflareDomainSync(currentDomain);
		}

		return clearCloudflareFields();
	}

	const integration = await findCloudflareIntegrationById(
		nextDomain.cloudflareIntegrationId,
	);
	if (!integration.defaultTunnelId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"The selected Cloudflare integration does not have a default tunnel configured",
		});
	}

	if (
		currentDomain?.publishToCloudflare &&
		hasCloudflareBindingChanged(
			currentDomain,
			nextDomain,
			integration.defaultTunnelId,
		)
	) {
		await removeCloudflareDomainSync(currentDomain);
	}

	const zone = await findCloudflareZoneForHostname({
		apiToken: integration.apiToken,
		hostname: nextDomain.host,
		preferredZoneId: integration.defaultZoneId,
		preferredZoneName: integration.defaultZoneName,
	});
	const origin = await getCloudflareOriginService(nextDomain);

	await upsertCloudflareTunnelIngress({
		apiToken: integration.apiToken,
		accountId: integration.accountId,
		tunnelId: integration.defaultTunnelId,
		hostname: nextDomain.host,
		path: nextDomain.path,
		service: origin.service,
		originRequest: origin.originRequest,
	});

	const dnsRecord = await upsertCloudflareDnsRecord({
		apiToken: integration.apiToken,
		zoneId: zone.id,
		hostname: nextDomain.host,
		tunnelId: integration.defaultTunnelId,
		domainId: nextDomain.domainId,
		existingDnsRecordId:
			currentDomain?.cloudflareDnsRecordId || nextDomain.cloudflareDnsRecordId,
	});

	return {
		publishToCloudflare: true,
		cloudflareIntegrationId: integration.cloudflareIntegrationId,
		cloudflareZoneId: zone.id,
		cloudflareZoneName: zone.name,
		cloudflareTunnelId: integration.defaultTunnelId,
		cloudflareTunnelName: integration.defaultTunnelName,
		cloudflareDnsRecordId: dnsRecord.id,
	} satisfies Partial<Domain>;
};

export const createDomain = async (input: z.infer<typeof apiCreateDomain>) => {
	let createdDomain: Domain | undefined;

	try {
		const domain = await db
			.insert(domains)
			.values({
				...input,
				domainId: nanoid(),
				host: input.host?.trim(),
			} as typeof domains.$inferInsert)
			.returning()
			.then((response) => response[0]);

		if (!domain) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating domain",
			});
		}

		createdDomain = domain;

		if (domain.applicationId) {
			const application = await findApplicationById(domain.applicationId);
			await manageDomain(application, domain);
		}

		if (domain.publishToCloudflare) {
			const cloudflareMetadata = await syncCloudflareDomain(domain);
			createdDomain =
				(await updateDomainById(domain.domainId, cloudflareMetadata)) || domain;
		}

		return createdDomain;
	} catch (error) {
		if (createdDomain) {
			if (createdDomain.applicationId) {
				const application = await findApplicationById(
					createdDomain.applicationId,
				).catch(() => null);
				if (application) {
					await removeTraefikDomain(
						application,
						createdDomain?.uniqueConfigKey || 0,
					).catch(() => null);
				}
			}

			await removeCloudflareDomainSync(createdDomain).catch(() => null);
			await db
				.delete(domains)
				.where(eq(domains.domainId, createdDomain.domainId));
		}

		throw error;
	}
};

export const generateTraefikMeDomain = async (
	appName: string,
	_userId: string,
	serverId?: string,
) => {
	if (serverId) {
		const server = await findServerById(serverId);
		return generateRandomDomain({
			serverIp: server.ipAddress,
			projectName: appName,
		});
	}

	if (process.env.NODE_ENV === "development") {
		return generateRandomDomain({
			serverIp: "",
			projectName: appName,
		});
	}
	const settings = await getWebServerSettings();
	return generateRandomDomain({
		serverIp: settings?.serverIp || "",
		projectName: appName,
	});
};

export const generateWildcardDomain = (
	appName: string,
	serverDomain: string,
) => {
	return `${appName}-${serverDomain}`;
};

export const findDomainById = async (domainId: string) => {
	const domain = await db.query.domains.findFirst({
		where: eq(domains.domainId, domainId),
		with: {
			application: true,
		},
	});
	if (!domain) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Domain not found",
		});
	}
	return domain;
};

export const findDomainsByApplicationId = async (applicationId: string) => {
	const domainsArray = await db.query.domains.findMany({
		where: eq(domains.applicationId, applicationId),
		with: {
			application: true,
		},
	});

	return domainsArray;
};

export const findDomainsByComposeId = async (composeId: string) => {
	const domainsArray = await db.query.domains.findMany({
		where: eq(domains.composeId, composeId),
		with: {
			compose: true,
		},
	});

	return domainsArray;
};

export const updateDomainById = async (
	domainId: string,
	domainData: Partial<Domain>,
) => {
	const domain = await db
		.update(domains)
		.set({
			...domainData,
			...(domainData.host && { host: domainData.host.trim() }),
		})
		.where(eq(domains.domainId, domainId))
		.returning();

	return domain[0];
};

export const removeDomainById = async (domainId: string) => {
	await findDomainById(domainId);
	const result = await db
		.delete(domains)
		.where(eq(domains.domainId, domainId))
		.returning();

	return result[0];
};

export const getDomainHost = (domain: Domain) => {
	return `${domain.https ? "https" : "http"}://${domain.host}`;
};

const resolveDns = promisify(dns.resolve4);

export const validateDomain = async (
	domain: string,
	expectedIp?: string,
): Promise<{
	isValid: boolean;
	resolvedIp?: string;
	error?: string;
	isCloudflare?: boolean;
	cdnProvider?: string;
}> => {
	try {
		// Remove protocol and path if present
		const cleanDomain = domain.replace(/^https?:\/\//, "").split("/")[0];

		// Resolve the domain to get its IP
		const ips = await resolveDns(cleanDomain || "");

		const resolvedIps = ips.map((ip) => ip.toString());

		// Check if any IP belongs to a CDN provider
		const cdnProvider = ips
			.map((ip) => detectCDNProvider(ip))
			.find((provider) => provider !== null);

		// If behind a CDN, we consider it valid but inform the user
		if (cdnProvider) {
			return {
				isValid: true,
				resolvedIp: resolvedIps.join(", "),
				cdnProvider: cdnProvider.displayName,
				error: cdnProvider.warningMessage,
			};
		}

		// If we have an expected IP, validate against it
		if (expectedIp) {
			return {
				isValid: resolvedIps.includes(expectedIp),
				resolvedIp: resolvedIps.join(", "),
				error: !resolvedIps.includes(expectedIp)
					? `Domain resolves to ${resolvedIps.join(", ")} but should point to ${expectedIp}`
					: undefined,
			};
		}

		// If no expected IP, just return the resolved IP
		return {
			isValid: true,
			resolvedIp: resolvedIps.join(", "),
		};
	} catch (error) {
		return {
			isValid: false,
			error:
				error instanceof Error ? error.message : "Failed to resolve domain",
		};
	}
};
