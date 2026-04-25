import { relations } from "drizzle-orm";
import { pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { cloudflareIntegration } from "./cloudflare";
import { server } from "./server";

export const cloudflareTunnelRuntimeMode = pgEnum(
    "cloudflareTunnelRuntimeMode",
    ["shared-managed"],
);

export const cloudflareTunnelRuntimeStatus = pgEnum(
    "cloudflareTunnelRuntimeStatus",
    ["pending", "running", "error", "stopped"],
);

export const cloudflareTunnelRuntime = pgTable("cloudflare_tunnel_runtime", {
    cloudflareTunnelRuntimeId: text("cloudflareTunnelRuntimeId")
        .notNull()
        .primaryKey()
        .$defaultFn(() => nanoid()),
    organizationId: text("organizationId")
        .notNull()
        .references(() => organization.id, { onDelete: "cascade" }),
    serverId: text("serverId").references(() => server.serverId, {
        onDelete: "cascade",
    }),
    cloudflareIntegrationId: text("cloudflareIntegrationId")
        .notNull()
        .references(() => cloudflareIntegration.cloudflareIntegrationId, {
            onDelete: "cascade",
        }),
    cloudflareTunnelId: text("cloudflareTunnelId").notNull(),
    cloudflareTunnelName: text("cloudflareTunnelName").notNull(),
    runtimeMode: cloudflareTunnelRuntimeMode("runtimeMode")
        .notNull()
        .default("shared-managed"),
    dockerResourceName: text("dockerResourceName").notNull(),
    status: cloudflareTunnelRuntimeStatus("status")
        .notNull()
        .default("pending"),
    lastError: text("lastError"),
    lastStartedAt: text("lastStartedAt"),
    lastSeenAt: text("lastSeenAt"),
    createdAt: text("createdAt")
        .notNull()
        .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updatedAt")
        .notNull()
        .$defaultFn(() => new Date().toISOString()),
});

export const cloudflareTunnelRuntimeRelations = relations(
    cloudflareTunnelRuntime,
    ({ one }) => ({
        organization: one(organization, {
            fields: [cloudflareTunnelRuntime.organizationId],
            references: [organization.id],
        }),
        server: one(server, {
            fields: [cloudflareTunnelRuntime.serverId],
            references: [server.serverId],
        }),
        cloudflareIntegration: one(cloudflareIntegration, {
            fields: [cloudflareTunnelRuntime.cloudflareIntegrationId],
            references: [cloudflareIntegration.cloudflareIntegrationId],
        }),
    }),
);