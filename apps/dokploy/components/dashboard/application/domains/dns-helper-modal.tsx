import { Cloud, Copy, HelpCircle, Server } from "lucide-react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

interface Props {
	domain: {
		host: string;
		https: boolean;
		path?: string;
	};
	serverIp?: string;
	publishToCloudflare?: boolean;
	cloudflareTunnelName?: string | null;
}

export const DnsHelperModal = ({
	domain,
	serverIp,
	publishToCloudflare,
	cloudflareTunnelName,
}: Props) => {
	const copyToClipboard = (text: string) => {
		navigator.clipboard.writeText(text);
		toast.success("Copied to clipboard!");
	};

	return (
		<Dialog>
			<DialogTrigger>
				<Button variant="ghost" size="icon" className="group">
					<HelpCircle className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{publishToCloudflare ? (
							<Cloud className="size-5" />
						) : (
							<Server className="size-5" />
						)}
						{publishToCloudflare
							? "Cloudflare Tunnel Guide"
							: "DNS Configuration Guide"}
					</DialogTitle>
					<DialogDescription>
						{publishToCloudflare
							? `Dokploy will manage the Cloudflare Tunnel ingress and proxied DNS record for ${domain.host}`
							: `Follow these steps to configure your DNS records for ${domain.host}`}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<AlertBlock type="info">
						{publishToCloudflare
							? `This domain is configured to publish through Cloudflare Tunnel${cloudflareTunnelName ? ` using '${cloudflareTunnelName}'` : ""}.`
							: "To make your domain accessible, you need to configure your DNS records with your domain provider (e.g., Cloudflare, GoDaddy, NameCheap)."}
					</AlertBlock>

					<div className="flex flex-col gap-6">
						{publishToCloudflare ? (
							<div className="rounded-lg border p-4">
								<h3 className="font-medium mb-2">1. Dokploy Manages DNS For You</h3>
								<div className="flex flex-col gap-3">
									<p className="text-sm text-muted-foreground">
										Dokploy will create or update a proxied CNAME record for this
										hostname and attach the hostname to your selected Cloudflare
										tunnel.
									</p>
									<div className="bg-muted p-3 rounded-md text-sm">
										<p className="font-medium">Managed hostname: {domain.host}</p>
										<p>
											Tunnel: {cloudflareTunnelName || "Selected integration default"}
										</p>
									</div>
								</div>
							</div>
						) : (
							<div className="rounded-lg border p-4">
								<h3 className="font-medium mb-2">1. Add A Record</h3>
								<div className="flex flex-col gap-3">
									<p className="text-sm text-muted-foreground">
										Create an A record that points your domain to the server's IP
										address:
									</p>
									<div className="flex flex-col gap-2">
										<div className="flex items-center justify-between gap-2 bg-muted p-3 rounded-md">
											<div>
												<p className="text-sm font-medium">Type: A</p>
												<p className="text-sm">
													Name: @ or {domain.host.split(".")[0]}
												</p>
												<p className="text-sm">
													Value: {serverIp || "Your server IP"}
												</p>
											</div>
											<Button
												variant="ghost"
												size="icon"
												onClick={() => copyToClipboard(serverIp || "")}
												disabled={!serverIp}
											>
												<Copy className="size-4" />
											</Button>
										</div>
									</div>
								</div>
							</div>
						)}

						<div className="rounded-lg border p-4">
							<h3 className="font-medium mb-2">
								{publishToCloudflare ? "2. Verify Tunnel Routing" : "2. Verify Configuration"}
							</h3>
							<div className="flex flex-col gap-3">
								<p className="text-sm text-muted-foreground">
									{publishToCloudflare
										? "After Dokploy saves the domain configuration:"
										: "After configuring your DNS records:"}
								</p>
								<ul className="list-disc list-inside space-y-1 text-sm">
									<li>Wait for Cloudflare to propagate the DNS change</li>
									<li>
										Test your domain by visiting:{" "}
										{domain.https ? "https://" : "http://"}
										{domain.host}
										{domain.path || "/"}
									</li>
									<li>
										Use the domain validation action in Dokploy to verify the
										hostname resolves correctly
									</li>
								</ul>
							</div>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
