CREATE TYPE "public"."cloudflareTunnelRuntimeMode" AS ENUM('shared-managed');--> statement-breakpoint
CREATE TYPE "public"."cloudflareTunnelRuntimeStatus" AS ENUM('pending', 'running', 'error', 'stopped');--> statement-breakpoint
ALTER TYPE "public"."cloudflareTunnelMode" ADD VALUE 'shared-managed';--> statement-breakpoint
CREATE TABLE "cloudflare_tunnel_runtime" (
	"cloudflareTunnelRuntimeId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"serverId" text,
	"cloudflareIntegrationId" text NOT NULL,
	"cloudflareTunnelId" text NOT NULL,
	"cloudflareTunnelName" text NOT NULL,
	"runtimeMode" "cloudflareTunnelRuntimeMode" DEFAULT 'shared-managed' NOT NULL,
	"dockerResourceName" text NOT NULL,
	"status" "cloudflareTunnelRuntimeStatus" DEFAULT 'pending' NOT NULL,
	"lastError" text,
	"lastStartedAt" text,
	"lastSeenAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel_runtime" ADD CONSTRAINT "cloudflare_tunnel_runtime_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel_runtime" ADD CONSTRAINT "cloudflare_tunnel_runtime_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloudflare_tunnel_runtime" ADD CONSTRAINT "cloudflare_tunnel_runtime_cloudflareIntegrationId_cloudflare_integration_cloudflareIntegrationId_fk" FOREIGN KEY ("cloudflareIntegrationId") REFERENCES "public"."cloudflare_integration"("cloudflareIntegrationId") ON DELETE cascade ON UPDATE no action;