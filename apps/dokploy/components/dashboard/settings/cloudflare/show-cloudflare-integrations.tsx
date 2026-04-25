import { formatDate } from "date-fns";
import { Cloud, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { HandleCloudflareIntegration } from "./handle-cloudflare-integration";
import { ShowCloudflareRuntimes } from "./show-cloudflare-runtimes";

export const ShowCloudflareIntegrations = () => {
	const { data, isPending, refetch } = api.cloudflare.all.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { mutateAsync: removeIntegration, isPending: isRemoving } =
		api.cloudflare.remove.useMutation();

	return (
		<div className="w-full space-y-4">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-xl flex flex-row gap-2">
							<Cloud className="size-6 text-muted-foreground self-center" />
							Cloudflare
						</CardTitle>
						<CardDescription>
							Connect Cloudflare and pick the default zone and tunnel Dokploy
							should use for future domain automation.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-2 py-8 border-t">
						{isPending ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : data?.length === 0 ? (
							<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center">
								<Cloud className="size-8 self-center text-muted-foreground" />
								<span className="text-base text-muted-foreground text-center">
									Add your first Cloudflare integration to start testing the MVP
									flow.
								</span>
								{permissions?.organization.update && (
									<HandleCloudflareIntegration />
								)}
							</div>
						) : (
							<div className="flex flex-col gap-4 min-h-[25vh]">
								<div className="flex flex-col gap-4 rounded-lg">
									{data?.map((integration) => (
										<div
											key={integration.cloudflareIntegrationId}
											className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg"
										>
											<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border w-full gap-4">
												<div className="flex flex-col gap-2">
													<div className="flex items-center gap-2">
														<span className="text-sm font-medium">{integration.name}</span>
														<Badge variant="secondary">{integration.accountId}</Badge>
													</div>
													<div className="text-xs text-muted-foreground flex flex-col gap-1">
														<span>
															Default zone: {integration.defaultZoneName || "Not selected"}
														</span>
														<span>
															Default tunnel: {integration.defaultTunnelName || "Not selected"}
														</span>
														<span>
															Created at: {formatDate(new Date(integration.createdAt), "yyyy-MM-dd hh:mm:ss a")}
														</span>
													</div>
												</div>

												<div className="flex flex-row gap-1">
													<HandleCloudflareIntegration
														cloudflareIntegrationId={integration.cloudflareIntegrationId}
													/>
													<DialogAction
														title="Delete Cloudflare Integration"
														description="Are you sure you want to delete this Cloudflare integration?"
														type="destructive"
														onClick={async () => {
															await removeIntegration({
																cloudflareIntegrationId:
																	integration.cloudflareIntegrationId,
															})
																.then(() => {
																	toast.success("Cloudflare integration deleted");
																	refetch();
																})
																.catch((removeError) => {
																	toast.error("Failed to delete Cloudflare integration", {
																		description:
																			removeError instanceof Error
																				? removeError.message
																				: "Unknown error",
																	});
																});
														}}
													>
														<Button
															variant="ghost"
															size="icon"
															className="group hover:bg-red-500/10"
															isLoading={isRemoving}
														>
															<Trash2 className="size-4 text-primary group-hover:text-red-500" />
														</Button>
													</DialogAction>
												</div>
											</div>
										</div>
									))}
								</div>

								{permissions?.organization.update && (
									<div className="flex flex-row gap-2 flex-wrap w-full justify-end mr-4">
										<HandleCloudflareIntegration />
									</div>
								)}
							</div>
						)}
					</CardContent>
				</div>
			</Card>
			<ShowCloudflareRuntimes />
		</div>
	);
};