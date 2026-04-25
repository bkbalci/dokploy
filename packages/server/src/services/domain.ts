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
import { and, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { type apiCreateDomain, domains } from "../db/schema";
import { findApplicationById } from "./application";
import { detectCDNProvider } from "./cdn";
import {
	findCloudflareDnsRecord,
	findCloudflareIntegrationById,
	findCloudflareTunnelById,
	findCloudflareZoneForHostname,
	getCloudflareTunnelConfiguration,
	removeCloudflareDnsRecord,
	removeCloudflareTunnelIngress,
	upsertCloudflareDnsRecord,
	upsertCloudflareTunnelIngress,
} from "./cloudflare";
import {
	ensureSharedManagedCloudflareTunnelRuntime,
	releaseSharedManagedCloudflareTunnelRuntime,
} from "./cloudflare-runtime";
import { findComposeById } from "./compose";
import { findServerById } from "./server";

export type Domain = typeof domains.$inferSelect;
export type CloudflareTunnelUsageSummary = {
	totalDomains: number;
	sameServerDomains: number;
	sameServerName: string | null;
	modeCounts: {
		existingInstance: number;
		sidecar: number;
		sharedManaged: number;
	};
	sameServerModeCounts: {
		existingInstance: number;
		sidecar: number;
		sharedManaged: number;
	};
	references: Array<{
		domainId: string;
		host: string;
		cloudflareTunnelMode: Domain["cloudflareTunnelMode"];
		sameServer: boolean;
	}>;
};
export type CloudflareDomainDriftInspection = {
	checkedAt: string;
	status: "healthy" | "drifted" | "error";
	issues: string[];
	expectedService: string | null;
	observedService: string | null;
	expectedDnsTarget: string | null;
	observedDnsTarget: string | null;
	tunnelExists: boolean;
	routeExists: boolean;
	dnsExists: boolean;
};

const clearCloudflareFields = (): Partial<Domain> => ({
	publishToCloudflare: false,
	cloudflareTunnelMode: "existing-instance",
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

const matchesCloudflareIngressRule = (
	rule: {
		hostname?: string;
		path?: string;
		service?: string;
	},
	hostname: string,
	path?: string | null,
) => {
	return (
		(rule.hostname || "").toLowerCase() === hostname.toLowerCase() &&
		normalizeDomainPath(rule.path || null) === normalizeDomainPath(path)
	);
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
		currentDomain.cloudflareTunnelMode !== nextDomain.cloudflareTunnelMode ||
		currentDomain.cloudflareTunnelId !== nextTunnelId ||
		!nextDomain.publishToCloudflare
	);
};

const getCloudflareOriginService = async (domain: Domain) => {
	if (domain.cloudflareTunnelMode === "sidecar") {
		if (!domain.composeId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"Cloudflare sidecar mode is currently supported for compose services only",
			});
		}

		if (!domain.serviceName) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"A compose service name is required before Dokploy can create a Cloudflare sidecar",
			});
		}

		if (!domain.port) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"A container port is required before Dokploy can create a Cloudflare sidecar",
			});
		}

		return {
			service: `http://${domain.serviceName}:${domain.port}`,
			originRequest: undefined,
		};
	}

	if (domain.cloudflareTunnelMode === "shared-managed") {
		if (domain.https) {
			return {
				service: "https://dokploy-traefik:443",
				originRequest: {
					noTLSVerify: true,
				},
			};
		}

		return {
			service: "http://dokploy-traefik:80",
			originRequest: undefined,
		};
	}

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

	await releaseSharedManagedCloudflareTunnelRuntime(domain);
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
	const tunnelId = nextDomain.cloudflareTunnelId || integration.defaultTunnelId;
	if (!tunnelId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Select a Cloudflare tunnel for this domain or configure a default tunnel on the integration",
		});
	}

	const tunnel =
		integration.defaultTunnelId === tunnelId && integration.defaultTunnelName
			? {
				id: integration.defaultTunnelId,
				name: integration.defaultTunnelName,
			}
			: await findCloudflareTunnelById({
				apiToken: integration.apiToken,
				accountId: integration.accountId,
				tunnelId,
			});

	if (
		currentDomain?.publishToCloudflare &&
		hasCloudflareBindingChanged(currentDomain, nextDomain, tunnel.id)
	) {
		await removeCloudflareDomainSync(currentDomain);
	}

	let ensuredSharedRuntime = false;
	if (nextDomain.cloudflareTunnelMode === "shared-managed") {
		await ensureSharedManagedCloudflareTunnelRuntime({
			organizationId: integration.organizationId,
			cloudflareIntegrationId: integration.cloudflareIntegrationId,
			cloudflareTunnelId: tunnel.id,
			cloudflareTunnelName: tunnel.name,
			domain: nextDomain,
		});
		ensuredSharedRuntime = true;
	}

	try {
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
			tunnelId: tunnel.id,
			hostname: nextDomain.host,
			path: nextDomain.path,
			service: origin.service,
			originRequest: origin.originRequest,
		});

		const dnsRecord = await upsertCloudflareDnsRecord({
			apiToken: integration.apiToken,
			zoneId: zone.id,
			hostname: nextDomain.host,
			tunnelId: tunnel.id,
			domainId: nextDomain.domainId,
			existingDnsRecordId:
				currentDomain?.cloudflareDnsRecordId || nextDomain.cloudflareDnsRecordId,
		});

		return {
			publishToCloudflare: true,
			cloudflareTunnelMode:
				nextDomain.cloudflareTunnelMode || "existing-instance",
			cloudflareIntegrationId: integration.cloudflareIntegrationId,
			cloudflareZoneId: zone.id,
			cloudflareZoneName: zone.name,
			cloudflareTunnelId: tunnel.id,
			cloudflareTunnelName: tunnel.name,
			cloudflareDnsRecordId: dnsRecord.id,
		} satisfies Partial<Domain>;
	} catch (error) {
		const currentTunnelId =
			currentDomain?.cloudflareTunnelId ||
			(currentDomain?.publishToCloudflare
				? integration.defaultTunnelId
				: null);
		const alreadyUsingSharedRuntime =
			currentDomain?.cloudflareTunnelMode === "shared-managed" &&
			currentDomain.cloudflareIntegrationId === integration.cloudflareIntegrationId &&
			currentTunnelId === tunnel.id;

		if (ensuredSharedRuntime && !alreadyUsingSharedRuntime) {
			await releaseSharedManagedCloudflareTunnelRuntime(nextDomain).catch(
				() => null,
			);
		}

		throw error;
	}
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

export const getCloudflareTunnelUsageSummary = async ({
	organizationId,
	cloudflareIntegrationId,
	cloudflareTunnelId,
	applicationId,
	composeId,
	excludeDomainId,
}: {
	organizationId: string;
	cloudflareIntegrationId: string;
	cloudflareTunnelId: string;
	applicationId?: string;
	composeId?: string;
	excludeDomainId?: string;
}): Promise<CloudflareTunnelUsageSummary> => {
	const integration = await findCloudflareIntegrationById(cloudflareIntegrationId);

	if (integration.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not allowed to inspect this Cloudflare integration",
		});
	}

	let currentServerId: string | null = null;
	if (applicationId) {
		const application = await findApplicationById(applicationId);
		currentServerId = application.serverId ?? null;
	} else if (composeId) {
		const compose = await findComposeById(composeId);
		currentServerId = compose.serverId ?? null;
	}

	const currentServer = currentServerId
		? await findServerById(currentServerId).catch(() => null)
		: null;

	const results = await db.query.domains.findMany({
		where: and(
			eq(domains.publishToCloudflare, true),
			eq(domains.cloudflareIntegrationId, cloudflareIntegrationId),
			eq(domains.cloudflareTunnelId, cloudflareTunnelId),
			...(excludeDomainId ? [ne(domains.domainId, excludeDomainId)] : []),
		),
		columns: {
			domainId: true,
			host: true,
			cloudflareTunnelMode: true,
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

	const modeCounts = {
		existingInstance: 0,
		sidecar: 0,
		sharedManaged: 0,
	};
	const sameServerModeCounts = {
		existingInstance: 0,
		sidecar: 0,
		sharedManaged: 0,
	};

	const references = results.map((result) => {
		const serverId = result.application?.serverId ?? result.compose?.serverId ?? null;
		const sameServer = serverId === currentServerId;

		if (result.cloudflareTunnelMode === "sidecar") {
			modeCounts.sidecar += 1;
			if (sameServer) {
				sameServerModeCounts.sidecar += 1;
			}
		} else if (result.cloudflareTunnelMode === "shared-managed") {
			modeCounts.sharedManaged += 1;
			if (sameServer) {
				sameServerModeCounts.sharedManaged += 1;
			}
		} else {
			modeCounts.existingInstance += 1;
			if (sameServer) {
				sameServerModeCounts.existingInstance += 1;
			}
		}

		return {
			domainId: result.domainId,
			host: result.host,
			cloudflareTunnelMode: result.cloudflareTunnelMode,
			sameServer,
		};
	});

	return {
		totalDomains: results.length,
		sameServerDomains: references.filter((reference) => reference.sameServer).length,
		sameServerName: currentServer?.name || null,
		modeCounts,
		sameServerModeCounts,
		references,
	};
};

export const inspectCloudflareDomainDrift = async (
	domainId: string,
): Promise<CloudflareDomainDriftInspection> => {
	const checkedAt = new Date().toISOString();
	const domain = await findDomainById(domainId);
	const issues: string[] = [];
	let expectedService: string | null = null;
	let observedService: string | null = null;
	let expectedDnsTarget: string | null = null;
	let observedDnsTarget: string | null = null;
	let tunnelExists = false;
	let routeExists = false;
	let dnsExists = false;
	let hardError = false;

	if (!domain.publishToCloudflare || !domain.cloudflareIntegrationId) {
		return {
			checkedAt,
			status: "error",
			issues: ["This domain is not currently managed through Cloudflare Tunnel."],
			expectedService,
			observedService,
			expectedDnsTarget,
			observedDnsTarget,
			tunnelExists,
			routeExists,
			dnsExists,
		};
	}

	const integration = await findCloudflareIntegrationById(
		domain.cloudflareIntegrationId,
	).catch((error) => {
		hardError = true;
		issues.push(
			error instanceof Error
				? error.message
				: "Cloudflare integration could not be loaded.",
		);
		return null;
	});

	if (!integration) {
		return {
			checkedAt,
			status: "error",
			issues,
			expectedService,
			observedService,
			expectedDnsTarget,
			observedDnsTarget,
			tunnelExists,
			routeExists,
			dnsExists,
		};
	}

	const tunnelId = domain.cloudflareTunnelId || integration.defaultTunnelId;
	if (!tunnelId) {
		issues.push("Cloudflare tunnel selection is missing.");
	} else {
		expectedDnsTarget = `${tunnelId}.cfargotunnel.com`;
	}

	try {
		expectedService = (await getCloudflareOriginService(domain)).service;
	} catch (error) {
		issues.push(
			error instanceof Error
				? error.message
				: "Expected origin service could not be resolved.",
		);
	}

	if (tunnelId) {
		await findCloudflareTunnelById({
			apiToken: integration.apiToken,
			accountId: integration.accountId,
			tunnelId,
		})
			.then(() => {
				tunnelExists = true;
			})
			.catch((error) => {
				issues.push(
					error instanceof Error
						? error.message
						: "Cloudflare tunnel could not be found.",
				);
			});
	}

	if (tunnelId && tunnelExists) {
		await getCloudflareTunnelConfiguration({
			apiToken: integration.apiToken,
			accountId: integration.accountId,
			tunnelId,
		})
			.then((configuration) => {
				const rule = (configuration.config?.ingress || []).find((ingressRule) =>
					matchesCloudflareIngressRule(ingressRule, domain.host, domain.path),
				);

				if (!rule) {
					issues.push("Cloudflare tunnel ingress rule is missing.");
					return;
				}

				routeExists = true;
				observedService = rule.service || null;

				if (expectedService && observedService !== expectedService) {
					issues.push(
						`Cloudflare tunnel ingress points to '${observedService}' instead of '${expectedService}'.`,
					);
				}
			})
			.catch((error) => {
				hardError = true;
				issues.push(
					error instanceof Error
						? error.message
						: "Cloudflare tunnel configuration could not be read.",
				);
			});
	}

	if (!domain.cloudflareZoneId) {
		issues.push("Cloudflare zone metadata is missing.");
	} else {
		await findCloudflareDnsRecord(
			integration.apiToken,
			domain.cloudflareZoneId,
			domain.host,
		)
			.then((record) => {
				if (!record) {
					issues.push("Cloudflare DNS record is missing.");
					return;
				}

				dnsExists = true;
				observedDnsTarget = record.content;

				if (expectedDnsTarget && record.content !== expectedDnsTarget) {
					issues.push(
						`Cloudflare DNS points to '${record.content}' instead of '${expectedDnsTarget}'.`,
					);
				}

				if (!record.proxied) {
					issues.push("Cloudflare DNS record is not proxied.");
				}
			})
			.catch((error) => {
				hardError = true;
				issues.push(
					error instanceof Error
						? error.message
						: "Cloudflare DNS record could not be read.",
				);
			});
	}

	return {
		checkedAt,
		status: hardError ? "error" : issues.length > 0 ? "drifted" : "healthy",
		issues,
		expectedService,
		observedService,
		expectedDnsTarget,
		observedDnsTarget,
		tunnelExists,
		routeExists,
		dnsExists,
	};
};

export const repairCloudflareDomainDrift = async (
	domainId: string,
): Promise<CloudflareDomainDriftInspection> => {
	const domain = await findDomainById(domainId);

	if (!domain.publishToCloudflare) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "This domain is not managed through Cloudflare Tunnel.",
		});
	}

	const cloudflareMetadata = await syncCloudflareDomain(domain, domain);
	await updateDomainById(domainId, cloudflareMetadata);

	return inspectCloudflareDomainDrift(domainId);
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
