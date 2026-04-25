import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Cloud, DatabaseZap, Dices, Loader2, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
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
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input, NumberInput } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";

export type CacheType = "fetch" | "cache";

export const domain = z
	.object({
		host: z
			.string()
			.min(1, { message: "Add a hostname" })
			.refine((val) => val === val.trim(), {
				message: "Domain name cannot have leading or trailing spaces",
			})
			.transform((val) => val.trim()),
		path: z.string().min(1).optional(),
		internalPath: z.string().optional(),
		stripPath: z.boolean().optional(),
		port: z
			.number()
			.min(1, { message: "Port must be at least 1" })
			.max(65535, { message: "Port must be 65535 or below" })
			.optional(),
		useCustomEntrypoint: z.boolean(),
		customEntrypoint: z.string().optional(),
		https: z.boolean().optional(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
		customCertResolver: z.string().optional(),
		serviceName: z.string().optional(),
		domainType: z.enum(["application", "compose", "preview"]).optional(),
		publishToCloudflare: z.boolean().optional(),
		cloudflareTunnelMode: z
			.enum(["existing-instance", "sidecar", "shared-managed"])
			.optional(),
		cloudflareIntegrationId: z.string().optional(),
		cloudflareTunnelId: z.string().optional(),
		middlewares: z.array(z.string()).optional(),
	})
	.superRefine((input, ctx) => {
		if (input.https && !input.certificateType) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["certificateType"],
				message: "Required",
			});
		}

		if (input.certificateType === "custom" && !input.customCertResolver) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["customCertResolver"],
				message: "Required",
			});
		}

		if (input.domainType === "compose" && !input.serviceName) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["serviceName"],
				message: "Required",
			});
		}

		// Validate stripPath requires a valid path
		if (input.stripPath && (!input.path || input.path === "/")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["stripPath"],
				message:
					"Strip path can only be enabled when a path other than '/' is specified",
			});
		}

		// Validate internalPath starts with /
		if (
			input.internalPath &&
			input.internalPath !== "/" &&
			!input.internalPath.startsWith("/")
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["internalPath"],
				message: "Internal path must start with '/'",
			});
		}

		if (input.useCustomEntrypoint && !input.customEntrypoint) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["customEntrypoint"],
				message: "Custom entry point must be specified",
			});
		}

		if (input.publishToCloudflare && !input.cloudflareIntegrationId) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["cloudflareIntegrationId"],
				message: "Select a Cloudflare integration",
			});
		}

		if (input.publishToCloudflare && !input.cloudflareTunnelMode) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["cloudflareTunnelMode"],
				message: "Select how the tunnel should run",
			});
		}

		if (input.publishToCloudflare && !input.cloudflareTunnelId) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["cloudflareTunnelId"],
				message: "Select a Cloudflare tunnel",
			});
		}

		if (input.publishToCloudflare && input.host?.includes("traefik.me")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["host"],
				message: "traefik.me domains cannot be published through Cloudflare Tunnel",
			});
		}

		if (input.publishToCloudflare && input.useCustomEntrypoint) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["publishToCloudflare"],
				message:
					"Cloudflare Tunnel publish does not support custom Traefik entrypoints yet",
			});
		}

		if (
			input.publishToCloudflare &&
			input.cloudflareTunnelMode === "sidecar" &&
			input.domainType !== "compose"
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["cloudflareTunnelMode"],
				message:
					"Cloudflare sidecar mode is currently supported for compose services only",
			});
		}
	});

type Domain = z.infer<typeof domain>;

const buildSuggestedCloudflareTunnelName = (
	appName?: string,
	host?: string,
) => {
	const rawName = ["dokploy-sidecar", appName || "app", host || "domain"]
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	return (rawName || "dokploy-sidecar-tunnel").slice(0, 63);
};

interface Props {
	id: string;
	type: "application" | "compose";
	domainId?: string;
	children: React.ReactNode;
}

export const AddDomain = ({ id, type, domainId = "", children }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [cacheType, setCacheType] = useState<CacheType>("cache");
	const [isManualInput, setIsManualInput] = useState(false);
	const [newCloudflareTunnelName, setNewCloudflareTunnelName] = useState("");

	const utils = api.useUtils();
	const { data, refetch } = api.domain.one.useQuery(
		{
			domainId,
		},
		{
			enabled: !!domainId,
		},
	);

	const { data: application } =
		type === "application"
			? api.application.one.useQuery(
					{
						applicationId: id,
					},
					{
						enabled: !!id,
					},
				)
			: api.compose.one.useQuery(
					{
						composeId: id,
					},
					{
						enabled: !!id,
					},
				);

	const { mutateAsync, isError, error, isPending } = domainId
		? api.domain.update.useMutation()
		: api.domain.create.useMutation();

	const { mutateAsync: generateDomain, isPending: isLoadingGenerate } =
		api.domain.generateDomain.useMutation();
	const {
		data: cloudflareIntegrations,
		isLoading: isLoadingCloudflareIntegrations,
	} = api.domain.cloudflareOptions.useQuery(
		type === "application" ? { applicationId: id } : { composeId: id },
		{
			enabled: isOpen && !!id,
			refetchOnWindowFocus: false,
		},
	);

	const { data: canGenerateTraefikMeDomains } =
		api.domain.canGenerateTraefikMeDomains.useQuery({
			serverId: application?.serverId || "",
		});

	const {
		data: services,
		isFetching: isLoadingServices,
		error: errorServices,
		refetch: refetchServices,
	} = api.compose.loadServices.useQuery(
		{
			composeId: id,
			type: cacheType,
		},
		{
			retry: false,
			refetchOnWindowFocus: false,
			enabled: type === "compose" && !!id,
		},
	);

	const form = useForm<Domain>({
		resolver: zodResolver(domain),
		defaultValues: {
			host: "",
			path: undefined,
			internalPath: undefined,
			stripPath: false,
			port: undefined,
			useCustomEntrypoint: false,
			customEntrypoint: undefined,
			https: false,
			certificateType: undefined,
			customCertResolver: undefined,
			serviceName: undefined,
			domainType: type,
			publishToCloudflare: false,
			cloudflareTunnelMode: "existing-instance",
			cloudflareIntegrationId: undefined,
			cloudflareTunnelId: undefined,
			middlewares: [],
		},
		mode: "onChange",
	});

	const certificateType = form.watch("certificateType");
	const useCustomEntrypoint = form.watch("useCustomEntrypoint");
	const https = form.watch("https");
	const domainType = form.watch("domainType");
	const host = form.watch("host");
	const publishToCloudflare = form.watch("publishToCloudflare");
	const cloudflareTunnelMode = form.watch("cloudflareTunnelMode");
	const selectedCloudflareIntegrationId = form.watch("cloudflareIntegrationId");
	const selectedCloudflareTunnelId = form.watch("cloudflareTunnelId");
	const cloudflareTunnelQueryInput =
		type === "application"
			? {
				applicationId: id,
				cloudflareIntegrationId: selectedCloudflareIntegrationId || "",
			}
			: {
				composeId: id,
				cloudflareIntegrationId: selectedCloudflareIntegrationId || "",
			};
	const isTraefikMeDomain = host?.includes("traefik.me") || false;
	const selectedCloudflareIntegration = cloudflareIntegrations?.find(
		(integration) =>
			integration.cloudflareIntegrationId === selectedCloudflareIntegrationId,
	);
	const {
		data: cloudflareTunnelOptions,
		isLoading: isLoadingCloudflareTunnelOptions,
	} = api.domain.cloudflareTunnelOptions.useQuery(
		cloudflareTunnelQueryInput,
		{
			enabled:
				isOpen &&
				publishToCloudflare &&
				!!id &&
				!!selectedCloudflareIntegrationId,
			refetchOnWindowFocus: false,
		},
	);
	const {
		mutateAsync: createCloudflareTunnel,
		isPending: isCreatingCloudflareTunnel,
	} = api.domain.createCloudflareTunnel.useMutation();
	const selectedCloudflareTunnel = cloudflareTunnelOptions?.tunnels.find(
		(tunnel) => tunnel.id === selectedCloudflareTunnelId,
	);

	useEffect(() => {
		if (data) {
			form.reset({
				...data,
				/* Convert null to undefined */
				path: data?.path || undefined,
				internalPath: data?.internalPath || undefined,
				stripPath: data?.stripPath || false,
				port: data?.port || undefined,
				useCustomEntrypoint: !!data.customEntrypoint,
				customEntrypoint: data.customEntrypoint || undefined,
				certificateType: data?.certificateType || undefined,
				customCertResolver: data?.customCertResolver || undefined,
				serviceName: data?.serviceName || undefined,
				domainType: data?.domainType || type,
				publishToCloudflare: data?.publishToCloudflare || false,
				cloudflareTunnelMode:
					data?.cloudflareTunnelMode || "existing-instance",
				cloudflareIntegrationId:
					data?.cloudflareIntegrationId || undefined,
				cloudflareTunnelId: data?.cloudflareTunnelId || undefined,
				middlewares: data?.middlewares || [],
			});
		}

		if (!domainId) {
			form.reset({
				host: "",
				path: undefined,
				internalPath: undefined,
				stripPath: false,
				port: undefined,
				useCustomEntrypoint: false,
				customEntrypoint: undefined,
				https: false,
				certificateType: undefined,
				customCertResolver: undefined,
				domainType: type,
				publishToCloudflare: false,
					cloudflareTunnelMode: "existing-instance",
				cloudflareIntegrationId: undefined,
				cloudflareTunnelId: undefined,
				middlewares: [],
			});
		}
	}, [form, data, isPending, domainId]);

	useEffect(() => {
		if (
			isOpen &&
			!domainId &&
			!form.getValues("cloudflareIntegrationId") &&
			cloudflareIntegrations?.length === 1
		) {
			form.setValue(
				"cloudflareIntegrationId",
				cloudflareIntegrations[0]?.cloudflareIntegrationId,
				{ shouldValidate: true },
			);
		}
	}, [cloudflareIntegrations, domainId, form, isOpen]);

	useEffect(() => {
		if (
			!isOpen ||
			!publishToCloudflare ||
			cloudflareTunnelMode !== "sidecar" ||
			!!newCloudflareTunnelName
		) {
			return;
		}

		setNewCloudflareTunnelName(
			buildSuggestedCloudflareTunnelName(application?.appName, host),
		);
	}, [
		application?.appName,
		cloudflareTunnelMode,
		host,
		isOpen,
		newCloudflareTunnelName,
		publishToCloudflare,
	]);

	useEffect(() => {
		if (!publishToCloudflare) {
			return;
		}

		if (!selectedCloudflareIntegrationId) {
			if (form.getValues("cloudflareTunnelId")) {
				form.setValue("cloudflareTunnelId", undefined, {
					shouldValidate: true,
				});
			}
			return;
		}

		const tunnels = cloudflareTunnelOptions?.tunnels ?? [];
		if (tunnels.length === 0) {
			return;
		}

		const currentTunnelId = form.getValues("cloudflareTunnelId");
		const hasCurrentTunnel = tunnels.some(
			(tunnel) => tunnel.id === currentTunnelId,
		);

		if (hasCurrentTunnel) {
			return;
		}

		const preferredTunnelId =
			(selectedCloudflareIntegration?.defaultTunnelId &&
			tunnels.some(
				(tunnel) =>
					tunnel.id === selectedCloudflareIntegration.defaultTunnelId,
			)
				? selectedCloudflareIntegration.defaultTunnelId
				: undefined) || tunnels[0]?.id;

		if (preferredTunnelId) {
			form.setValue("cloudflareTunnelId", preferredTunnelId, {
				shouldValidate: true,
			});
		}
	}, [
		cloudflareTunnelOptions,
		form,
		publishToCloudflare,
		selectedCloudflareIntegration,
		selectedCloudflareIntegrationId,
	]);

	// Separate effect for handling custom cert resolver validation
	useEffect(() => {
		if (certificateType === "custom") {
			form.trigger("customCertResolver");
		}
	}, [certificateType, form]);

	const dictionary = {
		success: domainId ? "Domain Updated" : "Domain Created",
		error: domainId ? "Error updating the domain" : "Error creating the domain",
		submit: domainId ? "Update" : "Create",
		dialogDescription: domainId
			? "In this section you can edit a domain"
			: "In this section you can add domains",
	};

	const onSubmit = async (data: Domain) => {
		await mutateAsync({
			domainId,
			...(data.domainType === "application" && {
				applicationId: id,
			}),
			...(data.domainType === "compose" && {
				composeId: id,
			}),
			...data,
			cloudflareTunnelMode: data.publishToCloudflare
				? data.cloudflareTunnelMode
				: undefined,
			cloudflareTunnelId: data.publishToCloudflare
				? data.cloudflareTunnelId
				: undefined,
			customEntrypoint: data.useCustomEntrypoint ? data.customEntrypoint : null,
		})
			.then(async () => {
				toast.success(dictionary.success);

				if (data.domainType === "application") {
					await utils.domain.byApplicationId.invalidate({
						applicationId: id,
					});
					await utils.application.readTraefikConfig.invalidate({
						applicationId: id,
					});
				} else if (data.domainType === "compose") {
					await utils.domain.byComposeId.invalidate({
						composeId: id,
					});
				}

				if (domainId) {
					setNewCloudflareTunnelName("");
					refetch();
				}
				setIsOpen(false);
			})
			.catch((e) => {
				console.log(e);
				toast.error(dictionary.error);
			});
	};

	const handleCreateCloudflareTunnel = async () => {
		if (!selectedCloudflareIntegrationId) {
			toast.error("Select a Cloudflare integration first");
			return;
		}

		const tunnelName = newCloudflareTunnelName.trim();
		if (!tunnelName) {
			toast.error("Enter a tunnel name");
			return;
		}

		try {
			const createdTunnel = await createCloudflareTunnel({
				...cloudflareTunnelQueryInput,
				cloudflareIntegrationId: selectedCloudflareIntegrationId,
				name: tunnelName,
			});

			await utils.domain.cloudflareTunnelOptions.invalidate(
				cloudflareTunnelQueryInput,
			);
			form.setValue("cloudflareTunnelId", createdTunnel.id, {
				shouldValidate: true,
			});
			setNewCloudflareTunnelName(createdTunnel.name);
			toast.success(`Created Cloudflare tunnel '${createdTunnel.name}'`);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to create Cloudflare tunnel",
			);
		}
	};
	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger className="" asChild>
				{children}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Domain</DialogTitle>
					<DialogDescription>{dictionary.dialogDescription}</DialogDescription>
				</DialogHeader>
				{isError && <AlertBlock type="error">{error?.message}</AlertBlock>}

				{type === "compose" && (
					<AlertBlock type="info" className="mb-4">
						Whenever you make changes to domains, remember to redeploy your
						compose to apply the changes.
					</AlertBlock>
				)}

				<Form {...form}>
					<form
						id="hook-form"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-8 "
					>
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-2">
								<div className="flex flex-row items-end w-full gap-4">
									{domainType === "compose" && (
										<div className="flex flex-col gap-2 w-full">
											{errorServices && (
												<AlertBlock
													type="warning"
													className="[overflow-wrap:anywhere]"
												>
													{errorServices?.message}
												</AlertBlock>
											)}
											<FormField
												control={form.control}
												name="serviceName"
												render={({ field }) => (
													<FormItem className="w-full">
														<FormLabel>Service Name</FormLabel>
														<div className="flex gap-2">
															{isManualInput ? (
																<FormControl>
																	<Input
																		placeholder="Enter service name manually"
																		{...field}
																		className="w-full"
																	/>
																</FormControl>
															) : (
																<Select
																	onValueChange={field.onChange}
																	defaultValue={field.value || ""}
																>
																	<FormControl>
																		<SelectTrigger>
																			<SelectValue placeholder="Select a service name" />
																		</SelectTrigger>
																	</FormControl>

																	<SelectContent>
																		{services?.map((service, index) => (
																			<SelectItem
																				value={service}
																				key={`${service}-${index}`}
																			>
																				{service}
																			</SelectItem>
																		))}
																		<SelectItem value="none" disabled>
																			Empty
																		</SelectItem>
																	</SelectContent>
																</Select>
															)}
															{!isManualInput && (
																<>
																	<TooltipProvider delayDuration={0}>
																		<Tooltip>
																			<TooltipTrigger asChild>
																				<Button
																					variant="secondary"
																					type="button"
																					isLoading={isLoadingServices}
																					onClick={() => {
																						if (cacheType === "fetch") {
																							refetchServices();
																						} else {
																							setCacheType("fetch");
																						}
																					}}
																				>
																					<RefreshCw className="size-4 text-muted-foreground" />
																				</Button>
																			</TooltipTrigger>
																			<TooltipContent
																				side="left"
																				sideOffset={5}
																				className="max-w-[10rem]"
																			>
																				<p>
																					Fetch: Will clone the repository and
																					load the services
																				</p>
																			</TooltipContent>
																		</Tooltip>
																	</TooltipProvider>
																	<TooltipProvider delayDuration={0}>
																		<Tooltip>
																			<TooltipTrigger asChild>
																				<Button
																					variant="secondary"
																					type="button"
																					isLoading={isLoadingServices}
																					onClick={() => {
																						if (cacheType === "cache") {
																							refetchServices();
																						} else {
																							setCacheType("cache");
																						}
																					}}
																				>
																					<DatabaseZap className="size-4 text-muted-foreground" />
																				</Button>
																			</TooltipTrigger>
																			<TooltipContent
																				side="left"
																				sideOffset={5}
																				className="max-w-[10rem]"
																			>
																				<p>
																					Cache: If you previously deployed this
																					compose, it will read the services
																					from the last deployment/fetch from
																					the repository
																				</p>
																			</TooltipContent>
																		</Tooltip>
																	</TooltipProvider>
																</>
															)}
															<TooltipProvider delayDuration={0}>
																<Tooltip>
																	<TooltipTrigger asChild>
																		<Button
																			variant="secondary"
																			type="button"
																			onClick={() => {
																				setIsManualInput(!isManualInput);
																				if (!isManualInput) {
																					field.onChange("");
																				}
																			}}
																		>
																			{isManualInput ? (
																				<RefreshCw className="size-4 text-muted-foreground" />
																			) : (
																				<span className="text-xs text-muted-foreground">
																					Manual
																				</span>
																			)}
																		</Button>
																	</TooltipTrigger>
																	<TooltipContent
																		side="left"
																		sideOffset={5}
																		className="max-w-[10rem]"
																	>
																		<p>
																			{isManualInput
																				? "Switch to service selection"
																				: "Enter service name manually"}
																		</p>
																	</TooltipContent>
																</Tooltip>
															</TooltipProvider>
														</div>

														<FormMessage />
													</FormItem>
												)}
											/>
										</div>
									)}
								</div>
								<FormField
									control={form.control}
									name="host"
									render={({ field }) => (
										<FormItem>
											{!canGenerateTraefikMeDomains &&
												field.value.includes("traefik.me") && (
													<AlertBlock type="warning">
														You need to set an IP address in your{" "}
														<Link
															href="/dashboard/settings/server"
															className="text-primary"
														>
															{application?.serverId
																? "Remote Servers -> Server -> Edit Server -> Update IP Address"
																: "Web Server -> Server -> Update Server IP"}
														</Link>{" "}
														to make your traefik.me domain work.
													</AlertBlock>
												)}
											{isTraefikMeDomain && (
												<AlertBlock type="info">
													<strong>Note:</strong> traefik.me is a public HTTP
													service and does not support SSL/HTTPS. HTTPS and
													certificate options will not have any effect.
												</AlertBlock>
											)}
											<FormLabel>Host</FormLabel>
											<div className="flex gap-2">
												<FormControl>
													<Input placeholder="api.dokploy.com" {...field} />
												</FormControl>
												<TooltipProvider delayDuration={0}>
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																variant="secondary"
																type="button"
																isLoading={isLoadingGenerate}
																onClick={() => {
																	generateDomain({
																		appName: application?.appName || "",
																		serverId: application?.serverId || "",
																	})
																		.then((domain) => {
																			field.onChange(domain);
																		})
																		.catch((err) => {
																			toast.error(err.message);
																		});
																}}
															>
																<Dices className="size-4 text-muted-foreground" />
															</Button>
														</TooltipTrigger>
														<TooltipContent
															side="left"
															sideOffset={5}
															className="max-w-[10rem]"
														>
															<p>Generate traefik.me domain</p>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											</div>

											<FormMessage />
										</FormItem>
									)}
								/>

										<FormField
											control={form.control}
											name="publishToCloudflare"
											render={({ field }) => (
												<FormItem className="flex flex-row items-center justify-between p-3 border rounded-lg shadow-sm">
													<div className="space-y-0.5">
														<FormLabel className="flex items-center gap-2">
															<Cloud className="size-4" />
															Publish Through Cloudflare Tunnel
														</FormLabel>
														<FormDescription>
															Dokploy will manage the tunnel ingress and proxied CNAME for
															this domain using the selected Cloudflare integration.
														</FormDescription>
														<FormMessage />
													</div>
													<FormControl>
														<Switch
															checked={field.value}
															onCheckedChange={field.onChange}
														/>
													</FormControl>
												</FormItem>
											)}
										/>

										{publishToCloudflare && (
											<div className="flex flex-col gap-4 rounded-lg border p-4">
												{cloudflareIntegrations?.length === 0 ? (
													<AlertBlock type="warning">
														No Cloudflare integrations are available for this organization.
														Configure one under{" "}
														<Link href="/dashboard/settings/cloudflare" className="text-primary">
															Settings → Cloudflare
														</Link>
														first.
													</AlertBlock>
												) : null}

												<FormField
													control={form.control}
													name="cloudflareIntegrationId"
													render={({ field }) => (
														<FormItem>
															<FormLabel>Cloudflare Integration</FormLabel>
															<Select
																onValueChange={field.onChange}
																value={field.value}
																disabled={isLoadingCloudflareIntegrations}
															>
																<FormControl>
																	<SelectTrigger>
																		<SelectValue placeholder="Select a Cloudflare integration" />
																	</SelectTrigger>
																</FormControl>
																<SelectContent>
																	{cloudflareIntegrations?.map((integration) => (
																		<SelectItem
																			key={integration.cloudflareIntegrationId}
																			value={integration.cloudflareIntegrationId}
																		>
																			{integration.name}
																		</SelectItem>
																	))}
																</SelectContent>
															</Select>
															{isLoadingCloudflareIntegrations ? (
																<div className="flex items-center gap-2 text-sm text-muted-foreground">
																	<Loader2 className="size-4 animate-spin" />
																	Loading Cloudflare integrations...
																</div>
															) : null}
															<FormMessage />
														</FormItem>
													)}
												/>

												<FormField
													control={form.control}
													name="cloudflareTunnelMode"
													render={({ field }) => (
														<FormItem>
															<FormLabel>Tunnel Runtime</FormLabel>
															<Select
																onValueChange={field.onChange}
																value={field.value}
															>
																<FormControl>
																	<SelectTrigger>
																		<SelectValue placeholder="Select how the tunnel should run" />
																	</SelectTrigger>
																</FormControl>
																<SelectContent>
																	<SelectItem value="existing-instance">
																		Use Existing Tunnel Instance
																	</SelectItem>
																	<SelectItem value="shared-managed">
																		Use Dokploy Managed Shared Connector
																	</SelectItem>
																	<SelectItem value="sidecar" disabled={type !== "compose"}>
																		Start Cloudflared Sidecar
																	</SelectItem>
																</SelectContent>
															</Select>
															<FormDescription>
																{type === "compose"
																	? "Use an already running cloudflared instance, let Dokploy run one shared connector on the target server, or start a sidecar in this compose deployment."
																	: "Application services support existing tunnel instances and the Dokploy-managed shared connector."}
															</FormDescription>
															<FormMessage />
														</FormItem>
													)}
												/>

												{selectedCloudflareIntegration ? (
													<>
														<FormField
															control={form.control}
															name="cloudflareTunnelId"
															render={({ field }) => (
																<FormItem>
																	<FormLabel>Cloudflare Tunnel</FormLabel>
																	<Select
																		onValueChange={field.onChange}
																		value={field.value}
																		disabled={isLoadingCloudflareTunnelOptions}
																	>
																		<FormControl>
																			<SelectTrigger>
																				<SelectValue placeholder="Select a Cloudflare tunnel" />
																			</SelectTrigger>
																		</FormControl>
																		<SelectContent>
																			{cloudflareTunnelOptions?.tunnels.map((tunnel) => (
																				<SelectItem key={tunnel.id} value={tunnel.id}>
																					{tunnel.name}
																					{tunnel.isDokployManaged ? " · Dokploy" : ""}
																				</SelectItem>
																			))}
																		</SelectContent>
																	</Select>
																	{isLoadingCloudflareTunnelOptions ? (
																		<div className="flex items-center gap-2 text-sm text-muted-foreground">
																			<Loader2 className="size-4 animate-spin" />
																			Loading Cloudflare tunnels...
																		</div>
																	) : null}
																	<FormMessage />
																</FormItem>
															)}
														/>

																{cloudflareTunnelMode === "sidecar" ? (
																	<div className="grid gap-2 rounded-md border border-dashed p-3">
																		<div className="text-sm font-medium">
																			Create Dedicated Tunnel
																		</div>
																		<FormDescription>
																			Create a Dokploy-managed sidecar tunnel just for this test or deployment.
																		</FormDescription>
																		<div className="flex gap-2">
																			<Input
																				value={newCloudflareTunnelName}
																				onChange={(event) =>
																					setNewCloudflareTunnelName(event.target.value)
																				}
																				placeholder="dokploy-sidecar-my-app"
																				maxLength={63}
																			/>
																			<Button
																				type="button"
																				variant="secondary"
																				onClick={handleCreateCloudflareTunnel}
																				isLoading={isCreatingCloudflareTunnel}
																				disabled={!selectedCloudflareIntegrationId}
																			>
																				Create Tunnel
																			</Button>
																		</div>
																	</div>
																) : null}

														<AlertBlock
															type={
																cloudflareTunnelOptions?.tunnels.length
																	? "info"
																	: "warning"
															}
														>
															{cloudflareTunnelOptions?.tunnels.length
																? selectedCloudflareTunnel
																	? cloudflareTunnelMode === "sidecar"
																		? `Dokploy will start a cloudflared sidecar for tunnel '${selectedCloudflareTunnel.name}' and route '${host || "this host"}' directly to the selected compose service.${selectedCloudflareTunnel.isDokployManaged ? " This tunnel was created by Dokploy." : ""}`
																		: cloudflareTunnelMode === "shared-managed"
																			? `Dokploy will reuse or start one shared cloudflared connector for tunnel '${selectedCloudflareTunnel.name}' on the target server and route '${host || "this host"}' through Dokploy Traefik.${selectedCloudflareTunnel.isDokployManaged ? " This tunnel was created by Dokploy." : ""}`
																			: `Dokploy will publish '${host || "this host"}' into tunnel '${selectedCloudflareTunnel.name}'.${selectedCloudflareIntegration.defaultTunnelId === selectedCloudflareTunnel.id ? " This integration default is preselected for convenience." : ""}${selectedCloudflareTunnel.isDokployManaged ? " This tunnel was created by Dokploy." : ""}`
																	: "Select which Cloudflare tunnel should receive this domain route."
																: cloudflareTunnelMode === "sidecar"
																	? "No Cloudflare tunnels were found for the selected integration/account yet. Create a dedicated sidecar tunnel below."
																	: cloudflareTunnelMode === "shared-managed"
																		? "No Cloudflare tunnels were found for the selected integration/account. Create or select a tunnel first, then Dokploy can manage a shared connector for it."
																	: "No Cloudflare tunnels were found for the selected integration/account."}
														</AlertBlock>
													</>
												) : null}
											</div>
										)}

								<FormField
									control={form.control}
									name="path"
									render={({ field }) => {
										return (
											<FormItem>
												<FormLabel>Path</FormLabel>
												<FormControl>
													<Input placeholder={"/"} {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										);
									}}
								/>

								<FormField
									control={form.control}
									name="internalPath"
									render={({ field }) => {
										return (
											<FormItem>
												<FormLabel>Internal Path</FormLabel>
												<FormDescription>
													The path where your application expects to receive
													requests internally (defaults to "/")
												</FormDescription>
												<FormControl>
													<Input placeholder={"/"} {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										);
									}}
								/>

								<FormField
									control={form.control}
									name="stripPath"
									render={({ field }) => (
										<FormItem className="flex flex-row items-center justify-between p-3 border rounded-lg shadow-sm">
											<div className="space-y-0.5">
												<FormLabel>Strip Path</FormLabel>
												<FormDescription>
													Remove the external path from the request before
													forwarding to the application
												</FormDescription>
												<FormMessage />
											</div>
											<FormControl>
												<Switch
													checked={field.value}
													onCheckedChange={field.onChange}
												/>
											</FormControl>
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="port"
									render={({ field }) => {
										return (
											<FormItem>
												<FormLabel>Container Port</FormLabel>
												<FormDescription>
													The port where your application is running inside the
													container (e.g., 3000 for Node.js, 80 for Nginx, 8080
													for Java)
												</FormDescription>
												<FormControl>
													<NumberInput placeholder={"3000"} {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										);
									}}
								/>

								<FormField
									control={form.control}
									name="useCustomEntrypoint"
									render={({ field }) => (
										<FormItem className="flex flex-row items-center justify-between p-3 mt-4 border rounded-lg shadow-sm">
											<div className="space-y-0.5">
												<FormLabel>Custom Entrypoint</FormLabel>
												<FormDescription>
													Use custom entrypoint for domain
													<br />
													"web" and/or "websecure" is used by default.
												</FormDescription>
												<FormMessage />
											</div>
											<FormControl>
												<Switch
													checked={field.value}
													onCheckedChange={(checked) => {
														field.onChange(checked);
														if (!checked) {
															form.setValue("customEntrypoint", undefined);
														}
													}}
												/>
											</FormControl>
										</FormItem>
									)}
								/>

								{useCustomEntrypoint && (
									<FormField
										control={form.control}
										name="customEntrypoint"
										render={({ field }) => (
											<FormItem className="w-full">
												<FormLabel>Entrypoint Name</FormLabel>
												<FormControl>
													<Input
														placeholder="Enter entrypoint name manually"
														{...field}
														className="w-full"
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								)}

								<FormField
									control={form.control}
									name="https"
									render={({ field }) => (
										<FormItem className="flex flex-row items-center justify-between p-3 mt-4 border rounded-lg shadow-sm">
											<div className="space-y-0.5">
												<FormLabel>HTTPS</FormLabel>
												<FormDescription>
													Automatically provision SSL Certificate.
												</FormDescription>
												<FormMessage />
											</div>
											<FormControl>
												<Switch
													checked={field.value}
													onCheckedChange={field.onChange}
												/>
											</FormControl>
										</FormItem>
									)}
								/>

								{https && (
									<>
										<FormField
											control={form.control}
											name="certificateType"
											render={({ field }) => {
												return (
													<FormItem>
														<FormLabel>Certificate Provider</FormLabel>
														<Select
															onValueChange={(value) => {
																field.onChange(value);
																if (value !== "custom") {
																	form.setValue(
																		"customCertResolver",
																		undefined,
																	);
																}
															}}
															value={field.value}
														>
															<FormControl>
																<SelectTrigger>
																	<SelectValue placeholder="Select a certificate provider" />
																</SelectTrigger>
															</FormControl>
															<SelectContent>
																<SelectItem value={"none"}>None</SelectItem>
																<SelectItem value={"letsencrypt"}>
																	Let's Encrypt
																</SelectItem>
																<SelectItem value={"custom"}>Custom</SelectItem>
															</SelectContent>
														</Select>
														<FormMessage />
													</FormItem>
												);
											}}
										/>

										{certificateType === "custom" && (
											<FormField
												control={form.control}
												name="customCertResolver"
												render={({ field }) => {
													return (
														<FormItem>
															<FormLabel>Custom Certificate Resolver</FormLabel>
															<FormControl>
																<Input
																	className="w-full"
																	placeholder="Enter your custom certificate resolver"
																	{...field}
																	value={field.value || ""}
																	onChange={(e) => {
																		field.onChange(e);
																		form.trigger("customCertResolver");
																	}}
																/>
															</FormControl>
															<FormMessage />
														</FormItem>
													);
												}}
											/>
										)}
									</>
								)}
								<FormField
									control={form.control}
									name="middlewares"
									render={({ field }) => (
										<FormItem>
											<div className="flex items-center gap-2">
												<FormLabel>Middlewares</FormLabel>
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger>
															<div className="size-4 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold">
																?
															</div>
														</TooltipTrigger>
														<TooltipContent className="max-w-[300px]">
															<p>
																Add Traefik middleware references. Middlewares
																must be defined in your Traefik configuration.
															</p>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											</div>
											<div className="flex flex-wrap gap-2 mb-2">
												{field.value?.map((name, index) => (
													<Badge key={index} variant="secondary">
														{name}
														<X
															className="ml-1 size-3 cursor-pointer"
															onClick={() => {
																const newMiddlewares = [...(field.value || [])];
																newMiddlewares.splice(index, 1);
																form.setValue("middlewares", newMiddlewares);
															}}
														/>
													</Badge>
												))}
											</div>
											<FormControl>
												<div className="flex gap-2">
													<Input
														placeholder="e.g., rate-limit@file, auth@file"
														onKeyDown={(e) => {
															if (e.key === "Enter") {
																e.preventDefault();
																const input = e.currentTarget;
																const value = input.value.trim();
																if (value && !field.value?.includes(value)) {
																	form.setValue("middlewares", [
																		...(field.value || []),
																		value,
																	]);
																	input.value = "";
																}
															}
														}}
													/>
													<Button
														type="button"
														variant="secondary"
														onClick={() => {
															const input = document.querySelector(
																'input[placeholder="e.g., rate-limit@file, auth@file"]',
															) as HTMLInputElement;
															const value = input.value.trim();
															if (value && !field.value?.includes(value)) {
																form.setValue("middlewares", [
																	...(field.value || []),
																	value,
																]);
																input.value = "";
															}
														}}
													>
														Add
													</Button>
												</div>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</div>
						</div>
					</form>

					<DialogFooter>
						<Button isLoading={isPending} form="hook-form" type="submit">
							{dictionary.submit}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
