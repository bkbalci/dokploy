ALTER TABLE "domain" ADD COLUMN "publishToCloudflare" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "cloudflareIntegrationId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "cloudflareZoneId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "cloudflareZoneName" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "cloudflareTunnelId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "cloudflareTunnelName" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "cloudflareDnsRecordId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_cloudflareIntegrationId_cloudflare_integration_cloudflareIntegrationId_fk" FOREIGN KEY ("cloudflareIntegrationId") REFERENCES "public"."cloudflare_integration"("cloudflareIntegrationId") ON DELETE set null ON UPDATE no action;