import {
    cleanupUnusedSharedManagedCloudflareTunnelRuntimes,
    createCloudflareIntegration,
    findCloudflareIntegrationById,
    listCloudflareIntegrationsByOrganizationId,
    listSharedManagedCloudflareTunnelRuntimes,
    recreateSharedManagedCloudflareTunnelRuntime,
    removeCloudflareIntegration,
    restartSharedManagedCloudflareTunnelRuntime,
    testCloudflareConnection,
    updateCloudflareIntegration,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, createTRPCRouter } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
    apiCreateCloudflareIntegration,
    apiFindCloudflareIntegration,
    apiRemoveCloudflareIntegration,
    apiTestCloudflareConnection,
    apiUpdateCloudflareIntegration,
} from "@/server/db/schema";

export const cloudflareRouter = createTRPCRouter({
    all: adminProcedure.query(async ({ ctx }) => {
        return await listCloudflareIntegrationsByOrganizationId(
            ctx.session.activeOrganizationId,
        );
    }),
    one: adminProcedure
        .input(apiFindCloudflareIntegration)
        .query(async ({ input, ctx }) => {
            const integration = await findCloudflareIntegrationById(
                input.cloudflareIntegrationId,
            );

            if (integration.organizationId !== ctx.session.activeOrganizationId) {
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "You are not allowed to access this Cloudflare integration",
                });
            }

            return integration;
        }),
    create: adminProcedure
        .input(apiCreateCloudflareIntegration)
        .mutation(async ({ input, ctx }) => {
            const integration = await createCloudflareIntegration(
                input,
                ctx.session.activeOrganizationId,
                ctx.session.userId,
            );

            await audit(ctx, {
                action: "create",
                resourceType: "settings",
                resourceId: integration.cloudflareIntegrationId,
                resourceName: integration.name,
            });

            return integration;
        }),
    update: adminProcedure
        .input(apiUpdateCloudflareIntegration)
        .mutation(async ({ input, ctx }) => {
            const existing = await findCloudflareIntegrationById(
                input.cloudflareIntegrationId,
            );

            if (existing.organizationId !== ctx.session.activeOrganizationId) {
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "You are not allowed to update this Cloudflare integration",
                });
            }

            const { cloudflareIntegrationId, ...updates } = input;
            const integration = await updateCloudflareIntegration(
                cloudflareIntegrationId,
                updates,
            );

            await audit(ctx, {
                action: "update",
                resourceType: "settings",
                resourceId: cloudflareIntegrationId,
                resourceName: existing.name,
            });

            return integration;
        }),
    remove: adminProcedure
        .input(apiRemoveCloudflareIntegration)
        .mutation(async ({ input, ctx }) => {
            const existing = await findCloudflareIntegrationById(
                input.cloudflareIntegrationId,
            );

            if (existing.organizationId !== ctx.session.activeOrganizationId) {
                throw new TRPCError({
                    code: "UNAUTHORIZED",
                    message: "You are not allowed to remove this Cloudflare integration",
                });
            }

            await audit(ctx, {
                action: "delete",
                resourceType: "settings",
                resourceId: existing.cloudflareIntegrationId,
                resourceName: existing.name,
            });

            return await removeCloudflareIntegration(input.cloudflareIntegrationId);
        }),
    testConnection: adminProcedure
        .input(apiTestCloudflareConnection)
        .mutation(async ({ input }) => {
            return await testCloudflareConnection(input);
        }),
    sharedRuntimes: adminProcedure.query(async ({ ctx }) => {
        return await listSharedManagedCloudflareTunnelRuntimes(
            ctx.session.activeOrganizationId,
        );
    }),
    restartSharedRuntime: adminProcedure
        .input(
            z.object({
                cloudflareTunnelRuntimeId: z.string().min(1),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const runtime = await restartSharedManagedCloudflareTunnelRuntime({
                organizationId: ctx.session.activeOrganizationId,
                cloudflareTunnelRuntimeId: input.cloudflareTunnelRuntimeId,
            });

            await audit(ctx, {
                action: "update",
                resourceType: "settings",
                resourceId: runtime.cloudflareTunnelRuntimeId,
                resourceName: runtime.cloudflareTunnelName,
            });

            return runtime;
        }),
    recreateSharedRuntime: adminProcedure
        .input(
            z.object({
                cloudflareTunnelRuntimeId: z.string().min(1),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const runtime = await recreateSharedManagedCloudflareTunnelRuntime({
                organizationId: ctx.session.activeOrganizationId,
                cloudflareTunnelRuntimeId: input.cloudflareTunnelRuntimeId,
            });

            await audit(ctx, {
                action: "update",
                resourceType: "settings",
                resourceId: runtime.cloudflareTunnelRuntimeId,
                resourceName: runtime.cloudflareTunnelName,
            });

            return runtime;
        }),
    cleanupUnusedSharedRuntimes: adminProcedure.mutation(async ({ ctx }) => {
        const result = await cleanupUnusedSharedManagedCloudflareTunnelRuntimes(
            ctx.session.activeOrganizationId,
        );

        await audit(ctx, {
            action: "delete",
            resourceType: "settings",
            resourceId: "cloudflare-shared-runtime-cleanup",
            resourceName: `Cleaned ${result.cleanedCount} shared runtimes`,
        });

        return result;
    }),
});
