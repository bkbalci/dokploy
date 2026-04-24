import { relations } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { user } from "./user";

export const cloudflareIntegration = pgTable("cloudflare_integration", {
    cloudflareIntegrationId: text("cloudflareIntegrationId")
        .notNull()
        .primaryKey()
        .$defaultFn(() => nanoid()),
    name: text("name").notNull(),
    apiToken: text("apiToken").notNull(),
    accountId: text("accountId").notNull(),
    defaultZoneId: text("defaultZoneId"),
    defaultZoneName: text("defaultZoneName"),
    defaultTunnelId: text("defaultTunnelId"),
    defaultTunnelName: text("defaultTunnelName"),
    organizationId: text("organizationId")
        .notNull()
        .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("userId")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const cloudflareIntegrationRelations = relations(
    cloudflareIntegration,
    ({ one }) => ({
        organization: one(organization, {
            fields: [cloudflareIntegration.organizationId],
            references: [organization.id],
        }),
        user: one(user, {
            fields: [cloudflareIntegration.userId],
            references: [user.id],
        }),
    }),
);

const createSchema = createInsertSchema(cloudflareIntegration, {
    cloudflareIntegrationId: z.string().min(1),
    name: z.string().min(1),
    apiToken: z.string().min(1),
    accountId: z.string().min(1),
    defaultZoneId: z.string().optional().nullable(),
    defaultZoneName: z.string().optional().nullable(),
    defaultTunnelId: z.string().optional().nullable(),
    defaultTunnelName: z.string().optional().nullable(),
    organizationId: z.string().min(1),
    userId: z.string().min(1),
});

export const apiCreateCloudflareIntegration = createSchema.pick({
    name: true,
    apiToken: true,
    accountId: true,
    defaultZoneId: true,
    defaultZoneName: true,
    defaultTunnelId: true,
    defaultTunnelName: true,
});

export const apiUpdateCloudflareIntegration = createSchema
    .pick({
        cloudflareIntegrationId: true,
        name: true,
        apiToken: true,
        accountId: true,
        defaultZoneId: true,
        defaultZoneName: true,
        defaultTunnelId: true,
        defaultTunnelName: true,
    })
    .partial()
    .extend({
        cloudflareIntegrationId: z.string().min(1),
    });

export const apiRemoveCloudflareIntegration = z.object({
    cloudflareIntegrationId: z.string().min(1),
});

export const apiFindCloudflareIntegration = z.object({
    cloudflareIntegrationId: z.string().min(1),
});

export const apiTestCloudflareConnection = z.object({
    apiToken: z.string().min(1),
    accountId: z.string().min(1),
});

export type ApiCreateCloudflareIntegration = z.infer<
    typeof apiCreateCloudflareIntegration
>;

export type ApiTestCloudflareConnection = z.infer<
    typeof apiTestCloudflareConnection
>;