import {
	createCloudflareTunnel,
	createDomain,
	findApplicationById,
	findCloudflareIntegrationById,
	findDomainById,
	findDomainsByApplicationId,
	findDomainsByComposeId,
	findPreviewDeploymentById,
	findServerById,
	generateTraefikMeDomain,
	getWebServerSettings,
	listCloudflareIntegrationsByOrganizationId,
	listCloudflareTunnels,
	manageDomain,
	removeCloudflareDomainSync,
	removeDomain,
	removeDomainById,
	syncCloudflareDomain,
	updateDomainById,
	validateDomain,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateCloudflareTunnel,
	apiCreateDomain,
	apiFindCompose,
	apiFindDomain,
	apiFindOneApplication,
	apiUpdateDomain,
} from "@/server/db/schema";

export const domainRouter = createTRPCRouter({
	cloudflareOptions: protectedProcedure
		.input(
			z
				.object({
					applicationId: z.string().optional(),
					composeId: z.string().optional(),
				})
				.refine((input) => !!input.applicationId || !!input.composeId, {
					message: "Application or compose id is required",
				}),
		)
		.query(async ({ input, ctx }) => {
			if (input.applicationId) {
				await checkServicePermissionAndAccess(ctx, input.applicationId, {
					domain: ["read"],
				});
			}

			if (input.composeId) {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					domain: ["read"],
				});
			}

			const integrations = await listCloudflareIntegrationsByOrganizationId(
				ctx.session.activeOrganizationId,
			);

			return integrations.map((integration) => ({
				cloudflareIntegrationId: integration.cloudflareIntegrationId,
				name: integration.name,
				defaultZoneName: integration.defaultZoneName,
				defaultTunnelId: integration.defaultTunnelId,
				defaultTunnelName: integration.defaultTunnelName,
			}));
		}),
	cloudflareTunnelOptions: protectedProcedure
		.input(
			z
				.object({
					applicationId: z.string().optional(),
					composeId: z.string().optional(),
					cloudflareIntegrationId: z.string().min(1),
				})
				.refine((input) => !!input.applicationId || !!input.composeId, {
					message: "Application or compose id is required",
				}),
		)
		.query(async ({ input, ctx }) => {
			if (input.applicationId) {
				await checkServicePermissionAndAccess(ctx, input.applicationId, {
					domain: ["read"],
				});
			}

			if (input.composeId) {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					domain: ["read"],
				});
			}

			const integration = await findCloudflareIntegrationById(
				input.cloudflareIntegrationId,
			);

			if (integration.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to use this Cloudflare integration",
				});
			}

			const tunnels = await listCloudflareTunnels(
				integration.apiToken,
				integration.accountId,
			);

			return {
				defaultTunnelId: integration.defaultTunnelId,
				defaultTunnelName: integration.defaultTunnelName,
				tunnels,
			};
		}),
	createCloudflareTunnel: protectedProcedure
		.input(
			apiCreateCloudflareTunnel
				.extend({
					applicationId: z.string().optional(),
					composeId: z.string().optional(),
				})
				.refine((input) => !!input.applicationId || !!input.composeId, {
					message: "Application or compose id is required",
				}),
		)
		.mutation(async ({ input, ctx }) => {
			if (input.applicationId) {
				await checkServicePermissionAndAccess(ctx, input.applicationId, {
					domain: ["create"],
				});
			}

			if (input.composeId) {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					domain: ["create"],
				});
			}

			const integration = await findCloudflareIntegrationById(
				input.cloudflareIntegrationId,
			);

			if (integration.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to use this Cloudflare integration",
				});
			}

			const tunnel = await createCloudflareTunnel({
				apiToken: integration.apiToken,
				accountId: integration.accountId,
				name: input.name,
			});

			await audit(ctx, {
				action: "create",
				resourceType: "settings",
				resourceId: tunnel.id,
				resourceName: tunnel.name,
			});

			return tunnel;
		}),
	create: protectedProcedure
		.input(apiCreateDomain)
		.mutation(async ({ input, ctx }) => {
			try {
				if (input.domainType === "compose" && input.composeId) {
					await checkServicePermissionAndAccess(ctx, input.composeId, {
						domain: ["create"],
					});
				} else if (input.domainType === "application" && input.applicationId) {
					await checkServicePermissionAndAccess(ctx, input.applicationId, {
						domain: ["create"],
					});
				}

				if (input.publishToCloudflare && input.cloudflareIntegrationId) {
					const integration = await findCloudflareIntegrationById(
						input.cloudflareIntegrationId,
					);
					if (integration.organizationId !== ctx.session.activeOrganizationId) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not allowed to use this Cloudflare integration",
						});
					}
				}

				const domain = await createDomain(input);
				await audit(ctx, {
					action: "create",
					resourceType: "domain",
					resourceId: domain.domainId,
					resourceName: domain.host,
				});
				return domain;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error creating the domain",
					cause: error,
				});
			}
		}),
	byApplicationId: protectedProcedure
		.input(apiFindOneApplication)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				domain: ["read"],
			});
			return await findDomainsByApplicationId(input.applicationId);
		}),
	byComposeId: protectedProcedure
		.input(apiFindCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				domain: ["read"],
			});
			return await findDomainsByComposeId(input.composeId);
		}),
	generateDomain: withPermission("domain", "create")
		.input(z.object({ appName: z.string(), serverId: z.string().optional() }))
		.mutation(async ({ input, ctx }) => {
			return generateTraefikMeDomain(
				input.appName,
				ctx.user.ownerId,
				input.serverId,
			);
		}),
	canGenerateTraefikMeDomains: withPermission("domain", "read")
		.input(z.object({ serverId: z.string() }))
		.query(async ({ input }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				return server.ipAddress;
			}
			const settings = await getWebServerSettings();
			return settings?.serverIp || "";
		}),

	update: protectedProcedure
		.input(apiUpdateDomain)
		.mutation(async ({ input, ctx }) => {
			const currentDomain = await findDomainById(input.domainId);
			const serviceId = currentDomain.applicationId || currentDomain.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					domain: ["create"],
				});
			} else if (currentDomain.previewDeploymentId) {
				const preview = await findPreviewDeploymentById(
					currentDomain.previewDeploymentId,
				);
				await checkServicePermissionAndAccess(ctx, preview.applicationId, {
					domain: ["create"],
				});
			}

			const nextDomain = {
				...currentDomain,
				...input,
				host: input.host?.trim() || currentDomain.host,
			} as typeof currentDomain;

			const nextCloudflareIntegrationId =
				nextDomain.publishToCloudflare && nextDomain.cloudflareIntegrationId
					? nextDomain.cloudflareIntegrationId
					: null;

			if (nextCloudflareIntegrationId) {
				const integration = await findCloudflareIntegrationById(
					nextCloudflareIntegrationId,
				);
				if (integration.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to use this Cloudflare integration",
					});
				}
			}

			const cloudflareMetadata = await syncCloudflareDomain(
				nextDomain,
				currentDomain,
			);

			const result = await updateDomainById(input.domainId, {
				...input,
				cloudflareTunnelMode: input.cloudflareTunnelMode || undefined,
				...cloudflareMetadata,
			});
			const domain = await findDomainById(input.domainId);
			await audit(ctx, {
				action: "update",
				resourceType: "domain",
				resourceId: domain.domainId,
				resourceName: domain.host,
			});
			if (domain.applicationId) {
				const application = await findApplicationById(domain.applicationId);
				await manageDomain(application, domain);
			} else if (domain.previewDeploymentId) {
				const previewDeployment = await findPreviewDeploymentById(
					domain.previewDeploymentId,
				);
				const application = await findApplicationById(
					previewDeployment.applicationId,
				);
				application.appName = previewDeployment.appName;
				await manageDomain(application, domain);
			}
			return result;
		}),
	one: protectedProcedure.input(apiFindDomain).query(async ({ input, ctx }) => {
		const domain = await findDomainById(input.domainId);
		const serviceId = domain.applicationId || domain.composeId;
		if (serviceId) {
			await checkServicePermissionAndAccess(ctx, serviceId, {
				domain: ["read"],
			});
		} else if (domain.previewDeploymentId) {
			const preview = await findPreviewDeploymentById(
				domain.previewDeploymentId,
			);
			await checkServicePermissionAndAccess(ctx, preview.applicationId, {
				domain: ["read"],
			});
		}
		return domain;
	}),
	delete: protectedProcedure
		.input(apiFindDomain)
		.mutation(async ({ input, ctx }) => {
			const domain = await findDomainById(input.domainId);
			const serviceId = domain.applicationId || domain.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					domain: ["delete"],
				});
			} else if (domain.previewDeploymentId) {
				const preview = await findPreviewDeploymentById(
					domain.previewDeploymentId,
				);
				await checkServicePermissionAndAccess(ctx, preview.applicationId, {
					domain: ["delete"],
				});
			}

			await removeCloudflareDomainSync(domain);

			const result = await removeDomainById(input.domainId);
			await audit(ctx, {
				action: "delete",
				resourceType: "domain",
				resourceId: domain.domainId,
				resourceName: domain.host,
			});

			if (domain.applicationId) {
				const application = await findApplicationById(domain.applicationId);
				await removeDomain(application, domain.uniqueConfigKey);
			}

			return result;
		}),

	validateDomain: withPermission("domain", "read")
		.input(
			z.object({
				domain: z.string(),
				serverIp: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			return validateDomain(input.domain, input.serverIp);
		}),
});
