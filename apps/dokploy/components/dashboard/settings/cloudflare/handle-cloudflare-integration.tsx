import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import {
	Cloud,
	Loader2,
	PenBoxIcon,
	PlusIcon,
	RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

const cloudflareIntegrationSchema = z.object({
	name: z.string().min(1, "Name is required"),
	apiToken: z.string().min(1, "API token is required"),
	accountId: z.string().min(1, "Account ID is required"),
	defaultZoneId: z.string().optional(),
	defaultTunnelId: z.string().optional(),
});

type CloudflareIntegrationForm = z.infer<typeof cloudflareIntegrationSchema>;

interface Props {
	cloudflareIntegrationId?: string;
}

interface ZoneOption {
	id: string;
	name: string;
	status: string;
	accountId: string | null;
	accountName: string | null;
}

interface TunnelOption {
	id: string;
	name: string;
	status: string;
	connectionCount: number;
	lastActiveAt: string | null;
	lastInactiveAt: string | null;
}

export const HandleCloudflareIntegration = ({
	cloudflareIntegrationId,
}: Props) => {
	const [open, setOpen] = useState(false);
	const [zones, setZones] = useState<ZoneOption[]>([]);
	const [tunnels, setTunnels] = useState<TunnelOption[]>([]);
	const [tokenStatus, setTokenStatus] = useState<string | null>(null);
	const utils = api.useUtils();

	const form = useForm<CloudflareIntegrationForm>({
		defaultValues: {
			name: "",
			apiToken: "",
			accountId: "",
			defaultZoneId: "",
			defaultTunnelId: "",
		},
		resolver: zodResolver(cloudflareIntegrationSchema),
	});

	const { data: integration } = api.cloudflare.one.useQuery(
		{
			cloudflareIntegrationId: cloudflareIntegrationId || "",
		},
		{
			enabled: open && !!cloudflareIntegrationId,
			refetchOnWindowFocus: false,
		},
	);

	const { mutateAsync, isPending, error, isError } = cloudflareIntegrationId
		? api.cloudflare.update.useMutation()
		: api.cloudflare.create.useMutation();

	const {
		mutateAsync: testConnection,
		isPending: isTestingConnection,
		error: connectionError,
		isError: isConnectionError,
	} = api.cloudflare.testConnection.useMutation();

	const selectedZone = form.watch("defaultZoneId");
	const selectedTunnel = form.watch("defaultTunnelId");

	const selectedZoneName = useMemo(() => {
		return zones.find((zone) => zone.id === selectedZone)?.name;
	}, [selectedZone, zones]);

	const selectedTunnelName = useMemo(() => {
		return tunnels.find((tunnel) => tunnel.id === selectedTunnel)?.name;
	}, [selectedTunnel, tunnels]);

	const loadConnectionResources = async (
		apiToken?: string,
		accountId?: string,
		showToast = true,
	) => {
		const values = {
			apiToken: apiToken ?? form.getValues("apiToken"),
			accountId: accountId ?? form.getValues("accountId"),
		};

		const result = await form.trigger(["apiToken", "accountId"]);
		if (!result && !apiToken && !accountId) {
			toast.error("API token and account ID are required");
			return;
		}

		try {
			const response = await testConnection(values);
			setZones(response.zones);
			setTunnels(response.tunnels);
			setTokenStatus(response.tokenStatus);

			if (showToast) {
				toast.success("Cloudflare connection verified");
			}
		} catch (fetchError) {
			if (showToast) {
				toast.error("Failed to verify Cloudflare connection", {
					description:
						fetchError instanceof Error
							? fetchError.message
							: "Unknown error",
				});
			}
		}
	};

	useEffect(() => {
		if (!open) {
			form.reset({
				name: "",
				apiToken: "",
				accountId: "",
				defaultZoneId: "",
				defaultTunnelId: "",
			});
			setZones([]);
			setTunnels([]);
			setTokenStatus(null);
			return;
		}

		if (!integration) {
			return;
		}

		form.reset({
			name: integration.name,
			apiToken: integration.apiToken,
			accountId: integration.accountId,
			defaultZoneId: integration.defaultZoneId || "",
			defaultTunnelId: integration.defaultTunnelId || "",
		});

		void loadConnectionResources(
			integration.apiToken,
			integration.accountId,
			false,
		);
	}, [form, integration, open]);

	const onSubmit = async (values: CloudflareIntegrationForm) => {
		await mutateAsync({
			cloudflareIntegrationId: cloudflareIntegrationId || "",
			name: values.name,
			apiToken: values.apiToken,
			accountId: values.accountId,
			defaultZoneId: values.defaultZoneId || null,
			defaultZoneName: selectedZoneName || null,
			defaultTunnelId: values.defaultTunnelId || null,
			defaultTunnelName: selectedTunnelName || null,
		})
			.then(async () => {
				toast.success(
					`Cloudflare integration ${cloudflareIntegrationId ? "updated" : "created"}`,
				);
				await utils.cloudflare.all.invalidate();
				if (cloudflareIntegrationId) {
					await utils.cloudflare.one.invalidate({
						cloudflareIntegrationId,
					});
				}
				setOpen(false);
			})
			.catch((submitError) => {
				toast.error("Failed to save Cloudflare integration", {
					description:
						submitError instanceof Error
							? submitError.message
							: "Unknown error",
				});
			});
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{cloudflareIntegrationId ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10"
					>
						<PenBoxIcon className="size-3.5 text-primary group-hover:text-blue-500" />
					</Button>
				) : (
					<Button className="cursor-pointer space-x-3">
						<PlusIcon className="h-4 w-4" />
						<span>Add Cloudflare</span>
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						Cloudflare Integration <Cloud className="size-5" />
					</DialogTitle>
					<DialogDescription>
						Connect an existing Cloudflare account and preselect the zone and
						remote-managed tunnel Dokploy should use by default.
					</DialogDescription>
				</DialogHeader>

				<AlertBlock type="info" className="w-full">
					Use an API token with Cloudflare Tunnel Edit and DNS Edit permissions.
				</AlertBlock>

				{(isError || isConnectionError) && (
					<AlertBlock type="error" className="w-full">
						{connectionError?.message || error?.message}
					</AlertBlock>
				)}

				<Form {...form}>
					<form
						id="hook-form-cloudflare-integration"
						onSubmit={form.handleSubmit(onSubmit)}
						className="space-y-4"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Primary Cloudflare" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<div className="grid gap-4 md:grid-cols-2">
							<FormField
								control={form.control}
								name="apiToken"
								render={({ field }) => (
									<FormItem>
										<FormLabel>API Token</FormLabel>
										<FormControl>
											<Input
												type="password"
												autoComplete="off"
												placeholder="cf_api_token"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="accountId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Account ID</FormLabel>
										<FormControl>
											<Input placeholder="Cloudflare account ID" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>

						<div className="flex flex-col gap-2 rounded-lg border p-4">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div>
									<div className="text-sm font-medium">Connection Status</div>
									<div className="text-xs text-muted-foreground">
										{tokenStatus
											? `Token status: ${tokenStatus}`
											: "Verify the token to load zones and tunnels."}
									</div>
								</div>
								<Button
									type="button"
									variant="secondary"
									onClick={() => void loadConnectionResources()}
									disabled={isTestingConnection}
								>
									{isTestingConnection ? (
										<Loader2 className="mr-2 size-4 animate-spin" />
									) : (
										<RefreshCw className="mr-2 size-4" />
									)}
									Test and Load
								</Button>
							</div>
						</div>

						<div className="grid gap-4 md:grid-cols-2">
							<FormField
								control={form.control}
								name="defaultZoneId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Default Zone</FormLabel>
										<Select
											onValueChange={field.onChange}
											value={field.value || undefined}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select a zone" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{zones.map((zone) => (
													<SelectItem key={zone.id} value={zone.id}>
														{zone.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="defaultTunnelId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Default Tunnel</FormLabel>
										<Select
											onValueChange={field.onChange}
											value={field.value || undefined}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select a tunnel" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{tunnels.map((tunnel) => (
													<SelectItem key={tunnel.id} value={tunnel.id}>
														{tunnel.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
					</form>
				</Form>

				<DialogFooter>
					<Button
						type="submit"
						form="hook-form-cloudflare-integration"
						disabled={isPending || isTestingConnection}
					>
						{isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
						Save Integration
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};