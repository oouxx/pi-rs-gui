import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderTree,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  ArrowLeft,
} from "lucide-react";
import {
  deleteMcpServer,
  getActiveSessionCwd,
  getMcpLog,
  getMcpResources,
  listMcpServers,
  readMcpResource,
  reconnectMcpServer,
  saveMcpServer,
  signInMcpServer,
  updateMcpServer,
  type McpConfigView,
} from "@/api/commands";
import type {
  McpExposure,
  McpResource,
  McpResourceContents,
  McpResourcesResult,
  McpServerInfo,
} from "@/api/types";
import { useI18n, type TranslationKey } from "@/i18n";

const EXPOSURES: { value: McpExposure; labelKey: TranslationKey }[] = [
  { value: "codemode", labelKey: "mcp.exposureCodemode" },
  { value: "deferred", labelKey: "mcp.exposureDeferred" },
  { value: "direct", labelKey: "mcp.exposureDirect" },
  { value: "hidden", labelKey: "mcp.exposureHidden" },
];

const STATUS_META: Record<
  string,
  { labelKey: TranslationKey; dot: string; text: string }
> = {
  connected: {
    labelKey: "mcp.statusConnected",
    dot: "bg-success",
    text: "text-success",
  },
  connecting: {
    labelKey: "mcp.statusConnecting",
    dot: "bg-warning",
    text: "text-warning",
  },
  "needs-auth": {
    labelKey: "mcp.statusNeedsAuth",
    dot: "bg-warning",
    text: "text-warning",
  },
  disconnected: {
    labelKey: "mcp.statusDisconnected",
    dot: "bg-warning",
    text: "text-warning",
  },
  failed: {
    labelKey: "mcp.statusFailed",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  disabled: {
    labelKey: "mcp.statusDisabled",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
  "not-loaded": {
    labelKey: "mcp.statusNotLoaded",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
  closed: {
    labelKey: "mcp.statusClosed",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
};

interface FormState {
  name: string;
  scope: "global" | "project";
  transport: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  timeout: string;
  exposure: McpExposure;
  description: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    scope: "global",
    transport: "stdio",
    command: "",
    args: "",
    env: "",
    cwd: "",
    url: "",
    headers: "",
    timeout: "",
    exposure: "codemode",
    description: "",
  };
}

function recordToLines(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join("\n");
}

function linesToRecord(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function linesToArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formFrom(server: McpServerInfo): FormState {
  const config = server.config as Record<string, unknown>;
  return {
    name: server.name,
    scope: server.scope === "project" ? "project" : "global",
    transport: server.transport,
    command: typeof config.command === "string" ? config.command : "",
    args: Array.isArray(config.args) ? (config.args as string[]).join("\n") : "",
    env: recordToLines(config.env),
    cwd: typeof config.cwd === "string" ? config.cwd : "",
    url: typeof config.url === "string" ? config.url : "",
    headers: recordToLines(config.headers),
    timeout: typeof config.timeout === "number" ? String(config.timeout) : "",
    exposure: server.exposure,
    description:
      typeof config.description === "string" ? config.description : "",
  };
}

/** Build the config entry, preserving fields the form does not model
 *  (`toolExposure`, `oauth`, `auth`, …) from `base`. */
function configFrom(
  form: FormState,
  base?: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(base ?? {}) };
  for (const key of [
    "type",
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "headers",
    "timeout",
    "description",
    "exposure",
  ]) {
    delete config[key];
  }

  config.type = form.transport;
  if (form.transport === "stdio") {
    config.command = form.command.trim();
    const args = linesToArgs(form.args);
    if (args.length > 0) config.args = args;
    const env = linesToRecord(form.env);
    if (env) config.env = env;
    const cwd = form.cwd.trim();
    if (cwd) config.cwd = cwd;
  } else {
    config.url = form.url.trim();
    const headers = linesToRecord(form.headers);
    if (headers) config.headers = headers;
  }

  const description = form.description.trim();
  if (description) config.description = description;
  config.exposure = form.exposure;

  const timeout = Number(form.timeout);
  if (form.timeout.trim() && Number.isFinite(timeout) && timeout > 0) {
    config.timeout = timeout;
  }
  return config;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-foreground text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground text-[11px]">{hint}</span>}
    </label>
  );
}

export default function McpSettings() {
  const { toast } = useToast();
  const { t } = useI18n();
  const [data, setData] = useState<McpConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerInfo | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logTitle, setLogTitle] = useState("");
  const [logText, setLogText] = useState("");
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [resourcesServer, setResourcesServer] = useState<McpServerInfo | null>(
    null,
  );
  const [resourcesData, setResourcesData] = useState<McpResourcesResult | null>(
    null,
  );
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const [activeResource, setActiveResource] = useState<McpResource | null>(null);
  const [resourceContents, setResourceContents] = useState<
    McpResourceContents[]
  >([]);
  const [resourceLoading, setResourceLoading] = useState(false);
  const cwdRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const cwd = await getActiveSessionCwd();
      cwdRef.current = cwd;
      const view = await listMcpServers(cwd);
      setData(view);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep polling while a server is still connecting (pi-rs connects MCP
  // servers asynchronously after the session actor starts).
  const connecting = data?.servers.some((s) => s.status === "connecting");
  useEffect(() => {
    if (!connecting) return;
    const id = setInterval(() => refresh(false), 2000);
    return () => clearInterval(id);
  }, [connecting, refresh]);

  const applyResult = useCallback(
    (view: McpConfigView, message: string) => {
      setData(view);
      if (view.applied === false && view.warning) {
        toast({
          title: message,
          description: view.warning,
          variant: "error",
        });
      } else {
        toast({ title: message, variant: "success" });
      }
    },
    [toast],
  );

  const fail = useCallback(
    (title: string, e: unknown) => {
      toast({
        title,
        description: e instanceof Error ? e.message : String(e),
        variant: "error",
      });
    },
    [toast],
  );

  const toggleExpand = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const setEnabled = useCallback(
    async (server: McpServerInfo) => {
      setBusy(server.name);
      try {
        const view = await updateMcpServer(
          server.name,
          { enabled: !server.enabled },
          cwdRef.current,
        );
        applyResult(
          view,
          t("mcp.setEnabled", { name: server.name, state: t(server.enabled ? "extensions.disabled" : "extensions.enabled") }),
        );
      } catch (e) {
        fail(t("mcp.updateFailed"), e);
      } finally {
        setBusy(null);
      }
    },
    [applyResult, fail, t],
  );

  const setExposure = useCallback(
    async (server: McpServerInfo, exposure: string) => {
      setBusy(server.name);
      try {
        const view = await updateMcpServer(
          server.name,
          { exposure },
          cwdRef.current,
        );
        applyResult(view, t("mcp.exposureSet", { name: server.name, exposure }));
      } catch (e) {
        fail(t("mcp.exposureFailed"), e);
      } finally {
        setBusy(null);
      }
    },
    [applyResult, fail, t],
  );

  const reconnect = useCallback(
    async (server: McpServerInfo) => {
      setBusy(server.name);
      try {
        await reconnectMcpServer(server.name);
        toast({ title: t("mcp.reconnected", { name: server.name }), variant: "success" });
        await refresh(false);
      } catch (e) {
        fail(t("mcp.reconnectFailed"), e);
      } finally {
        setBusy(null);
      }
    },
    [fail, refresh, toast, t],
  );

  const signIn = useCallback(
    async (server: McpServerInfo) => {
      setBusy(server.name);
      try {
        await signInMcpServer(server.name, cwdRef.current);
        toast({ title: t("mcp.signedIn", { name: server.name }), variant: "success" });
        await refresh(false);
      } catch (e) {
        fail(t("mcp.signInFailed"), e);
      } finally {
        setBusy(null);
      }
    },
    [fail, refresh, toast, t],
  );

  const remove = useCallback(
    async (server: McpServerInfo) => {
      setBusy(server.name);
      try {
        const view = await deleteMcpServer(server.name, cwdRef.current);
        setConfirmDelete(null);
        applyResult(view, t("mcp.deleted", { name: server.name }));
      } catch (e) {
        fail(t("mcp.deleteFailed"), e);
      } finally {
        setBusy(null);
      }
    },
    [applyResult, fail, t],
  );

  const openLog = useCallback(
    async (server: McpServerInfo) => {
      try {
        const text = await getMcpLog(server.name, 200);
        setLogTitle(`${server.name} — mcp.log`);
        setLogText(text || t("mcp.noLog"));
        setLogOpen(true);
      } catch (e) {
        fail(t("mcp.logFailed"), e);
      }
    },
    [fail, t],
  );

  const openResources = useCallback(async (server: McpServerInfo) => {
    setResourcesServer(server);
    setResourcesOpen(true);
    setResourcesData(null);
    setResourcesError(null);
    setActiveResource(null);
    setResourceContents([]);
    setResourcesLoading(true);
    try {
      setResourcesData(await getMcpResources(server.name));
    } catch (e) {
      setResourcesError(e instanceof Error ? e.message : String(e));
    } finally {
      setResourcesLoading(false);
    }
  }, []);

  const openResource = useCallback(
    async (resource: McpResource) => {
      if (!resourcesServer) return;
      setActiveResource(resource);
      setResourceContents([]);
      setResourcesError(null);
      setResourceLoading(true);
      try {
        const result = await readMcpResource(
          resourcesServer.name,
          resource.uri,
        );
        setResourceContents(result.contents ?? []);
      } catch (e) {
        setResourcesError(e instanceof Error ? e.message : String(e));
      } finally {
        setResourceLoading(false);
      }
    },
    [resourcesServer],
  );

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm());
    setDialogOpen(true);
  };

  const openEdit = (server: McpServerInfo) => {
    setEditing(server);
    setForm(formFrom(server));
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast({ title: t("mcp.nameRequired"), variant: "error" });
      return;
    }
    if (form.transport === "stdio" && !form.command.trim()) {
      toast({ title: t("mcp.commandRequired"), variant: "error" });
      return;
    }
    if (form.transport === "http" && !form.url.trim()) {
      toast({ title: t("mcp.urlRequired"), variant: "error" });
      return;
    }
    const config = configFrom(
      form,
      editing ? (editing.config as Record<string, unknown>) : undefined,
    );
    setBusy("__save__");
    try {
      const view = await saveMcpServer(
        form.name.trim(),
        config,
        form.scope,
        cwdRef.current,
      );
      setDialogOpen(false);
      applyResult(view, editing ? t("mcp.updated") : t("mcp.added"));
    } catch (e) {
      fail(t("mcp.saveFailed"), e);
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="text-muted-foreground p-8 text-sm">{t("mcp.loading")}</div>
    );
  }

  const servers = data?.servers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-md text-xs leading-relaxed">
          {t("mcp.description")}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refresh()}>
            <RefreshCw className="size-3.5" />
            {t("mcp.refresh")}
          </Button>
          <Button size="sm" onClick={openAdd}>
            <Plus className="size-3.5" />
            {t("mcp.addServer")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 text-destructive rounded-lg border p-3 text-xs">
          {error}
        </div>
      )}
      {data?.errors?.map((item) => (
        <div
          key={item}
          className="border-destructive/40 text-destructive rounded-lg border p-3 text-xs"
        >
          {item}
        </div>
      ))}

      {servers.length === 0 ? (
        <div className="border-hairline flex flex-col items-center gap-2 rounded-lg border p-12 text-center">
          <p className="text-foreground text-sm font-medium">{t("mcp.emptyTitle")}</p>
          <p className="text-muted-foreground max-w-sm text-xs">
            {t("mcp.emptyHint")}
          </p>
          <Button className="mt-2" size="sm" onClick={openAdd}>
            <Plus className="size-3.5" />
            {t("mcp.addFirst")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {servers.map((server) => {
            const meta = STATUS_META[server.status] ?? STATUS_META["not-loaded"];
            const isOpen = expanded.has(server.name);
            const isBusy = busy === server.name;
            const readOnly = server.scope === "extension";
            return (
              <div key={server.name} className="border-hairline rounded-lg border">
                {/* Header */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => toggleExpand(server.name)}
                    aria-label={isOpen ? t("mcp.collapse") : t("mcp.expand")}
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                  </button>
                  <span className={`size-2 shrink-0 rounded-full ${meta.dot}`} />
                  <span className="text-foreground text-sm font-medium">
                    {server.name}
                  </span>
                  <span className="text-muted-foreground text-[11px]">
                    {server.transport} · {server.scope}
                  </span>
                  <span className={`text-[11px] ${meta.text}`}>{t(meta.labelKey)}</span>
                  {isBusy && (
                    <Loader2 className="text-muted-foreground size-3 animate-spin" />
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <Select
                      value={server.exposure}
                      onValueChange={(value) => setExposure(server, value)}
                      disabled={readOnly || isBusy}
                    >
                      <SelectTrigger className="h-6 w-24 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EXPOSURES.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {t(item.labelKey)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Checkbox
                      checked={server.enabled}
                      disabled={readOnly || isBusy}
                      onCheckedChange={() => setEnabled(server)}
                      aria-label={t("mcp.enableServer")}
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={readOnly || isBusy}
                      onClick={() => openEdit(server)}
                      title={t("mcp.edit")} aria-label={t("mcp.edit")}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={readOnly}
                      onClick={() =>
                        setConfirmDelete(
                          confirmDelete === server.name ? null : server.name,
                        )
                      }
                      title={t("mcp.delete")} aria-label={t("mcp.delete")}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {confirmDelete === server.name && (
                  <div className="border-hairline flex items-center gap-2 border-t px-3 py-2">
                    <span className="text-destructive text-xs">
                      {t("mcp.confirmDelete", { name: server.name })}
                    </span>
                    <div className="ml-auto flex gap-1">
                      <Button
                        variant="destructive"
                        size="xs"
                        disabled={isBusy}
                        onClick={() => remove(server)}
                      >
                        {t("mcp.delete")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setConfirmDelete(null)}
                      >
                        {t("mcp.cancel")}
                      </Button>
                    </div>
                  </div>
                )}

                {server.error && (
                  <div className="text-destructive border-hairline border-t px-3 py-2 text-[11px] break-words">
                    {server.error}
                  </div>
                )}

                {isOpen && (
                  <div className="border-hairline space-y-3 border-t px-3 py-3">
                    <div className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-[11px]">
                      <span className="text-muted-foreground">{t("mcp.command")}</span>
                      <span className="font-mono break-all">
                        {server.command
                          ? [server.command, ...(server.args ?? [])].join(" ")
                          : "—"}
                      </span>
                      <span className="text-muted-foreground">{t("mcp.url")}</span>
                      <span className="font-mono break-all">{server.url ?? "—"}</span>
                      <span className="text-muted-foreground">{t("mcp.source")}</span>
                      <span className="font-mono break-all">
                        {server.source ?? "—"}
                        {server.overridePath
                          ? ` (overridden by ${server.overridePath})`
                          : ""}
                      </span>
                      <span className="text-muted-foreground">{t("mcp.resources")}</span>
                      <span>{server.hasResources ? t("mcp.yes") : t("mcp.no")}</span>
                    </div>

                    {server.description && (
                      <p className="text-muted-foreground text-xs">
                        {server.description}
                      </p>
                    )}
                    {server.instructions && (
                      <div>
                        <div className="text-foreground mb-1 text-xs font-medium">
                          {t("mcp.instructions")}
                        </div>
                        <p className="text-muted-foreground max-h-40 overflow-y-auto text-[11px] whitespace-pre-wrap">
                          {server.instructions}
                        </p>
                      </div>
                    )}

                    <div>
                      <div className="text-foreground mb-1 flex items-center gap-2 text-xs font-medium">
                        {t("mcp.tools")}
                        <span className="text-muted-foreground font-normal">
                          {server.tools.length}
                        </span>
                      </div>
                      {server.tools.length === 0 ? (
                        <p className="text-muted-foreground text-[11px]">
                          {t("mcp.noTools")}
                        </p>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {server.tools.map((tool) => (
                            <div key={tool.name} className="text-[11px]">
                              <span className="font-mono">{tool.name}</span>
                              {tool.description && (
                                <span className="text-muted-foreground">
                                  {" — "}
                                  {tool.description}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={isBusy}
                        onClick={() => reconnect(server)}
                      >
                        <RefreshCw className="size-3" />
                        {t("mcp.reconnect")}
                      </Button>
                      {server.status === "needs-auth" && (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={isBusy}
                          onClick={() => signIn(server)}
                        >
                          <KeyRound className="size-3" />
                          {t("mcp.signIn")}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => openLog(server)}
                      >
                        <FileText className="size-3" />
                        {t("mcp.viewLog")}
                      </Button>
                      {server.hasResources && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => openResources(server)}
                        >
                          <FolderTree className="size-3" />
                          {t("mcp.resourcesTitle")}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Separator />
      <div className="text-muted-foreground space-y-1 text-[11px]">
        <div>
          {t("mcp.globalConfig")} <span className="font-mono">{data?.globalConfigPath ?? "—"}</span>
        </div>
        <div>
          {t("mcp.projectConfig")} <span className="font-mono">{data?.projectConfigPath ?? "—"}</span>
        </div>
      </div>

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? t("mcp.editTitle") : t("mcp.addTitle")}</DialogTitle>
            <DialogDescription>
              {editing ? t("mcp.editDescription") : t("mcp.addDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-2">
            <Field label={t("mcp.name")} hint={t("mcp.nameHint")}>
              <Input
                className="h-8 text-xs"
                value={form.name}
                disabled={!!editing}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="filesystem"
              />
            </Field>

            {!editing && (
              <Field label={t("mcp.scope")}>
                <Select
                  value={form.scope}
                  onValueChange={(value) =>
                    setForm({ ...form, scope: value as FormState["scope"] })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">{t("mcp.scopeGlobal")}</SelectItem>
                    <SelectItem value="project">{t("mcp.scopeProject")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}

            <Field label={t("mcp.transport")}>
              <Select
                value={form.transport}
                onValueChange={(value) =>
                  setForm({ ...form, transport: value as FormState["transport"] })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">{t("mcp.transportStdio")}</SelectItem>
                  <SelectItem value="http">{t("mcp.transportHttp")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {form.transport === "stdio" ? (
              <>
                <Field label={t("mcp.command")}>
                  <Input
                    className="h-8 font-mono text-xs"
                    value={form.command}
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                    placeholder="npx"
                  />
                </Field>
                <Field label={t("mcp.arguments")} hint={t("mcp.argumentsHint")}>
                  <textarea
                    className="border-input bg-background focus-visible:border-ring min-h-16 rounded-lg border px-2.5 py-2 font-mono text-xs outline-none"
                    value={form.args}
                    onChange={(e) => setForm({ ...form, args: e.target.value })}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path"}
                  />
                </Field>
                <Field label={t("mcp.environment")} hint={t("mcp.envHint")}>
                  <textarea
                    className="border-input bg-background focus-visible:border-ring min-h-14 rounded-lg border px-2.5 py-2 font-mono text-xs outline-none"
                    value={form.env}
                    onChange={(e) => setForm({ ...form, env: e.target.value })}
                    placeholder="API_KEY=..."
                  />
                </Field>
                <Field label={t("mcp.workingDirectory")} hint={t("mcp.workingDirectoryHint")}>
                  <Input
                    className="h-8 font-mono text-xs"
                    value={form.cwd}
                    onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                    placeholder="~/projects/app"
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label={t("mcp.url")}>
                  <Input
                    className="h-8 font-mono text-xs"
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    placeholder="https://example.com/mcp"
                  />
                </Field>
                <Field label={t("mcp.headers")} hint={t("mcp.envHint")}>
                  <textarea
                    className="border-input bg-background focus-visible:border-ring min-h-14 rounded-lg border px-2.5 py-2 font-mono text-xs outline-none"
                    value={form.headers}
                    onChange={(e) => setForm({ ...form, headers: e.target.value })}
                    placeholder="Authorization=Bearer ..."
                  />
                </Field>
              </>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label={t("mcp.exposure")}>
                <Select
                  value={form.exposure}
                  onValueChange={(value) =>
                    setForm({ ...form, exposure: value as McpExposure })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPOSURES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {t(item.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("mcp.timeout")}>
                <Input
                  className="h-8 text-xs"
                  value={form.timeout}
                  onChange={(e) => setForm({ ...form, timeout: e.target.value })}
                  placeholder="60"
                />
              </Field>
            </div>

            <Field label={t("mcp.serverDescription")} hint={t("mcp.serverDescriptionHint")}>
              <Input
                className="h-8 text-xs"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Filesystem access"
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t("mcp.cancel")}
            </Button>
            <Button onClick={save} disabled={busy === "__save__"}>
              {busy === "__save__" && <Loader2 className="size-3.5 animate-spin" />}
              {editing ? t("mcp.save") : t("mcp.addServer")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Log dialog */}
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{logTitle}</DialogTitle>
            <DialogDescription>
              {t("mcp.logDescription")}
            </DialogDescription>
          </DialogHeader>
          <pre className="border-hairline bg-muted/30 max-h-[55vh] overflow-auto rounded-lg border p-3 font-mono text-[11px] whitespace-pre-wrap">
            {logText}
          </pre>
        </DialogContent>
      </Dialog>

      {/* MCP resources dialog */}
      <Dialog open={resourcesOpen} onOpenChange={setResourcesOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {resourcesServer?.name ?? "MCP"} — {t("mcp.resourcesTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("mcp.resourcesDescription")}
            </DialogDescription>
          </DialogHeader>

          {resourcesError && (
            <div className="text-destructive text-xs break-words">
              {resourcesError}
            </div>
          )}

          {resourcesLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t("mcp.loadingResources")}
            </div>
          ) : activeResource ? (
            <div className="space-y-3">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
                onClick={() => {
                  setActiveResource(null);
                  setResourceContents([]);
                  setResourcesError(null);
                }}
              >
                <ArrowLeft className="size-3.5" />
                {t("mcp.backToList")}
              </button>
              <div>
                <div className="text-foreground text-sm font-medium">
                  {activeResource.title ||
                    activeResource.name ||
                    activeResource.uri}
                </div>
                <div className="text-muted-foreground font-mono text-[11px] break-all">
                  {activeResource.uri}
                </div>
              </div>
              {resourceLoading ? (
                <div className="text-muted-foreground flex items-center gap-2 p-4 text-xs">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("mcp.readingResource")}
                </div>
              ) : (
                <pre className="border-hairline bg-muted/30 max-h-[50vh] overflow-auto rounded-lg border p-3 font-mono text-[11px] whitespace-pre-wrap">
                  {resourceContents.length === 0
                    ? t("mcp.noContents")
                    : resourceContents
                        .map(
                          (item) =>
                            item.text ??
                            `[binary ${item.mimeType ?? "blob"} · ${Math.round(((item.blob?.length ?? 0) * 3) / 4)} bytes]`,
                        )
                        .join("\n\n")}
                </pre>
              )}
            </div>
          ) : (
            <div className="max-h-[55vh] space-y-5 overflow-y-auto">
              <section>
                <h3 className="text-foreground mb-1.5 text-xs font-medium">
                  {t("mcp.resourcesTitle")}
                  <span className="text-muted-foreground ml-1 font-normal">
                    {resourcesData?.resources.length ?? 0}
                  </span>
                </h3>
                {(resourcesData?.resources.length ?? 0) === 0 ? (
                  <p className="text-muted-foreground text-[11px]">
                    {t("mcp.noResources")}
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {resourcesData?.resources.map((resource) => (
                      <button
                        key={resource.uri}
                        type="button"
                        onClick={() => openResource(resource)}
                        className="border-hairline hover:bg-muted/40 w-full rounded-md border px-2.5 py-2 text-left transition-colors"
                      >
                        <div className="text-foreground text-sm">
                          {resource.title ||
                            resource.name ||
                            resource.uri}
                        </div>
                        <div className="text-muted-foreground font-mono text-[11px] break-all">
                          {resource.uri}
                        </div>
                        {resource.description && (
                          <div className="text-muted-foreground mt-0.5 text-[11px]">
                            {resource.description}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 className="text-foreground mb-1.5 text-xs font-medium">
                  {t("mcp.templates")}
                  <span className="text-muted-foreground ml-1 font-normal">
                    {resourcesData?.templates.length ?? 0}
                  </span>
                </h3>
                {(resourcesData?.templates.length ?? 0) === 0 ? (
                  <p className="text-muted-foreground text-[11px]">
                    {t("mcp.noTemplates")}
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {resourcesData?.templates.map((template) => (
                      <div
                        key={template.uriTemplate}
                        className="border-hairline rounded-md border px-2.5 py-2"
                      >
                        <div className="text-foreground text-sm">
                          {template.title ||
                            template.name ||
                            template.uriTemplate}
                        </div>
                        <div className="text-muted-foreground font-mono text-[11px] break-all">
                          {template.uriTemplate}
                        </div>
                        {template.description && (
                          <div className="text-muted-foreground mt-0.5 text-[11px]">
                            {template.description}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
