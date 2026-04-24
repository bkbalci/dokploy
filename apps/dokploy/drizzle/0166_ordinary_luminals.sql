CREATE TABLE "cloudflare_integration" (
	"cloudflareIntegrationId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"apiToken" text NOT NULL,
	"accountId" text NOT NULL,
	"defaultZoneId" text,
	"defaultZoneName" text,
	"defaultTunnelId" text,
	"defaultTunnelName" text,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloudflare_integration" ADD CONSTRAINT "cloudflare_integration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloudflare_integration" ADD CONSTRAINT "cloudflare_integration_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;