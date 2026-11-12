import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/toast";
import {
  BookOpen,
  Download,
  FolderOpen,
  FolderPlus,
  Info,
  Loader2,
  Puzzle,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import ModelsSettings from "./ModelsSettings";
import McpSettings from "./McpSettings";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";
import { useChatContext } from "@/hooks/ChatProvider";
import { useI18n, type LanguagePreference } from "@/i18n";
import {
  checkForUpdate,
  downloadAndInstall,
  type Update,
  type UpdateInfo,
  type UpdateProgress,
} from "@/lib/updater";
import {
  KEYBINDING_DEFINITIONS,
  bindingFromEvent,
  findKeybindingConflict,
  formatBinding,
  useKeybindings,
} from "@/lib/keybindings";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  getActiveSessionCwd,
  getGeneralSettings,
  listExtensions,
  listSkills,
  openPath,
  setGeneralSetting,
} from "@/api/commands";

const settingsTabs = [
  { id: "general", labelKey: "settings.general", descKey: "settings.generalDesc" },
  { id: "models", labelKey: "settings.models", descKey: "settings.modelsDesc" },
  { id: "mcp", labelKey: "settings.mcp", descKey: "settings.mcpDesc" },
  { id: "skills", labelKey: "settings.skills", descKey: "settings.skillsDesc" },
  {
    id: "extensions",
    labelKey: "settings.extensions",
    descKey: "settings.extensionsDesc",
  },
  {
    id: "keybindings",
    labelKey: "settings.keybindings",
    descKey: "settings.keybindingsDesc",
  },
  { id: "about", labelKey: "settings.about", descKey: "settings.aboutDesc" },
] as const;

interface GeneralSettings {
  defaultThinkingLevel: string;
  compactionEnabled: boolean;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;
  retryEnabled: boolean;
  hideThinkingBlock: boolean;
  shellPath: string | null;
  quietStartup: boolean;
  theme: string | null;
  enableSkillCommands: boolean;
  skillPaths: string[];
  promptPaths: string[];
  steeringMode: string;
  followUpMode: string;
  transport: string;
  cacheWarming: string;
  showCacheMissNotices: boolean;
  externalEditor: string | null;
  defaultProjectTrust: string;
  shellCommandPrefix: string | null;
  npmCommand: string[] | null;
  collapseChangelog: boolean;
  paths?: {
    agentDir?: string;
    settingsPath?: string;
    sessionsDir?: string;
  };
  version?: string;
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
    </Row>
  );
}

/** Numeric input that commits on blur (avoids one IPC call per keystroke). */
function NumberField({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <Input
      className="h-8 w-28 text-xs tabular-nums"
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
      onBlur={() => {
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed > 0) onCommit(parsed);
        else setText(String(value));
      }}
    />
  );
}

/** Editable path list used by skill/prompt resource paths. */
function PathList({
  paths,
  placeholder,
  onAdd,
  onRemove,
}: {
  paths: string[];
  placeholder: string;
  onAdd: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="space-y-1.5">
      {paths.map((path) => (
        <div key={path} className="flex items-center gap-2">
          <span className="text-muted-foreground flex-1 truncate font-mono text-xs">
            {path}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onRemove(path)}
            title="Remove"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Input
          className="h-8 flex-1 font-mono text-xs"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const value = draft.trim();
            if (!value) return;
            onAdd(value);
            setDraft("");
          }}
        />
        <Button
          size="xs"
          variant="outline"
          className="h-8"
          onClick={() => {
            const value = draft.trim();
            if (!value) return;
            onAdd(value);
            setDraft("");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function GeneralTab() {
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const { preference, setTheme } = useTheme();
  const { preference: languagePreference, setLanguage, t } = useI18n();

  const refresh = useCallback(async () => {
    try {
      setSettings((await getGeneralSettings()) as GeneralSettings);
    } catch (e) {
      console.error("getGeneralSettings failed", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const apply = useCallback(
    async (key: keyof GeneralSettings, value: unknown) => {
      try {
        setSettings((await setGeneralSetting(key, value)) as GeneralSettings);
      } catch (e) {
        console.error(`set ${key} failed`, e);
      }
    },
    [],
  );

  if (!settings) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">{t("settings.appearance")}</h3>
        <Separator className="my-2" />
        <Row label={t("settings.appTheme")} hint={t("settings.appThemeHint")}>
          <Select
            value={preference}
            onValueChange={(value) =>
              setTheme(value as ThemePreference)
            }
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t("settings.language")} hint={t("settings.languageHint")}>
          <Select
            value={languagePreference}
            onValueChange={(value) =>
              setLanguage(value as LanguagePreference)
            }
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t("settings.system")}</SelectItem>
              <SelectItem value="en">{t("settings.english")}</SelectItem>
              <SelectItem value="zh">{t("settings.chinese")}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">{t("settings.behavior")}</h3>
        <Separator className="my-2" />
        <ToggleRow
          label="Auto-compact long conversations"
          hint="Summarize the context when it approaches the model window"
          checked={settings.compactionEnabled}
          onChange={(v) => apply("compactionEnabled", v)}
        />
        <Row label="Compaction reserve tokens" hint="Headroom kept below the context limit">
          <NumberField
            value={settings.compactionReserveTokens}
            onCommit={(v) => apply("compactionReserveTokens", v)}
          />
        </Row>
        <Row label="Compaction keep-recent tokens" hint="Recent context preserved verbatim">
          <NumberField
            value={settings.compactionKeepRecentTokens}
            onCommit={(v) => apply("compactionKeepRecentTokens", v)}
          />
        </Row>
        <Row
          label="Steering mode"
          hint="How queued steering messages are delivered mid-run"
        >
          <Select
            value={settings.steeringMode}
            onValueChange={(v) => apply("steeringMode", v)}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one-at-a-time">One at a time</SelectItem>
              <SelectItem value="all">All at once</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label="Follow-up mode"
          hint="How queued follow-up messages are delivered after a run"
        >
          <Select
            value={settings.followUpMode}
            onValueChange={(v) => apply("followUpMode", v)}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one-at-a-time">One at a time</SelectItem>
              <SelectItem value="all">All at once</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <ToggleRow
          label="Auto-retry failed requests"
          hint="Retry transient provider errors automatically"
          checked={settings.retryEnabled}
          onChange={(v) => apply("retryEnabled", v)}
        />
        <ToggleRow
          label="Show cache-miss notices"
          hint="Surface prompt-cache misses in the transcript"
          checked={settings.showCacheMissNotices}
          onChange={(v) => apply("showCacheMissNotices", v)}
        />
        <ToggleRow
          label="Hide thinking blocks"
          hint="Do not render reasoning blocks in the transcript"
          checked={settings.hideThinkingBlock}
          onChange={(v) => apply("hideThinkingBlock", v)}
        />
        <ToggleRow
          label="Quiet startup"
          hint="Suppress non-essential startup output"
          checked={settings.quietStartup}
          onChange={(v) => apply("quietStartup", v)}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">{t("settings.model")}</h3>
        <Separator className="my-2" />
        <Row label="Default thinking level" hint="Used when creating new sessions">
          <Select
            value={settings.defaultThinkingLevel}
            onValueChange={(v) => apply("defaultThinkingLevel", v)}
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="Agent theme" hint="Theme id passed to the agent (empty = default)">
          <Input
            className="h-8 w-40 text-xs"
            value={settings.theme ?? ""}
            placeholder="default"
            onBlur={(e) => apply("theme", e.target.value)}
          />
        </Row>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">{t("settings.shell")}</h3>
        <Separator className="my-2" />
        <Row
          label="Shell path"
          hint="Override the shell used by the bash tool (empty = system default)"
        >
          <Input
            className="h-8 w-64 font-mono text-xs"
            value={settings.shellPath ?? ""}
            placeholder="/bin/zsh"
            onBlur={(e) => apply("shellPath", e.target.value)}
          />
        </Row>
        <Row
          label="Shell command prefix"
          hint="Prepended to every bash tool command (e.g. mise exec --)"
        >
          <Input
            className="h-8 w-64 font-mono text-xs"
            value={settings.shellCommandPrefix ?? ""}
            placeholder="none"
            onBlur={(e) => apply("shellCommandPrefix", e.target.value)}
          />
        </Row>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">{t("settings.advanced")}</h3>
        <Separator className="my-2" />
        <Row
          label="Provider transport"
          hint="auto lets the provider choose between SSE and WebSocket"
        >
          <Select
            value={settings.transport}
            onValueChange={(v) => apply("transport", v)}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
              <SelectItem value="websocket">WebSocket</SelectItem>
              <SelectItem value="websocket-cached">WebSocket cached</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label="Prompt cache warming"
          hint="Idle warming costs money — off disables all warming"
        >
          <Select
            value={settings.cacheWarming}
            onValueChange={(v) => apply("cacheWarming", v)}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="streaming">While streaming</SelectItem>
              <SelectItem value="idle">While idle</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label="Default project trust"
          hint="Decision applied to projects without an explicit trust record"
        >
          <Select
            value={settings.defaultProjectTrust}
            onValueChange={(v) => apply("defaultProjectTrust", v)}
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">Ask</SelectItem>
              <SelectItem value="always">Always trust</SelectItem>
              <SelectItem value="never">Never trust</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label="External editor"
          hint="Command used to open files (empty = system default)"
        >
          <Input
            className="h-8 w-64 font-mono text-xs"
            value={settings.externalEditor ?? ""}
            placeholder="code"
            onBlur={(e) => apply("externalEditor", e.target.value)}
          />
        </Row>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">
          {t("settings.skillsPrompts")}
        </h3>
        <Separator className="my-2" />
        <ToggleRow
          label="Enable skill slash commands"
          hint="Expose discovered skills as /skill:name commands"
          checked={settings.enableSkillCommands}
          onChange={(v) => apply("enableSkillCommands", v)}
        />
        <Row label="Skill paths" hint="Extra directories scanned for skills">
          <span className="text-muted-foreground text-xs">
            {settings.skillPaths.length} path(s)
          </span>
        </Row>
        <PathList
          paths={settings.skillPaths}
          placeholder="/path/to/skills"
          onAdd={(path) =>
            apply("skillPaths", [...settings.skillPaths, path])
          }
          onRemove={(path) =>
            apply(
              "skillPaths",
              settings.skillPaths.filter((item) => item !== path),
            )
          }
        />
        <div className="mt-4" />
        <Row label="Prompt paths" hint="Extra directories scanned for /prompt templates">
          <span className="text-muted-foreground text-xs">
            {settings.promptPaths.length} path(s)
          </span>
        </Row>
        <PathList
          paths={settings.promptPaths}
          placeholder="/path/to/prompts"
          onAdd={(path) =>
            apply("promptPaths", [...settings.promptPaths, path])
          }
          onRemove={(path) =>
            apply(
              "promptPaths",
              settings.promptPaths.filter((item) => item !== path),
            )
          }
        />
      </section>
    </div>
  );
}

function AboutTab() {
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const { t } = useI18n();
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setSettings((await getGeneralSettings()) as GeneralSettings);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const checkUpdates = useCallback(async () => {
    setChecking(true);
    setChecked(true);
    setUpdateError(null);
    setUpdate(null);
    setUpdateInfo(null);
    setProgress(null);
    try {
      const result = await checkForUpdate();
      setUpdate(result.update);
      setUpdateInfo(result.info);
      if (!result.update) {
        toast({ title: t("updates.upToDate"), variant: "success" });
      }
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, [t, toast]);

  const install = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    setUpdateError(null);
    try {
      await downloadAndInstall(update, setProgress);
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setInstalling(false);
    }
  }, [update]);

  const percent = progress?.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : null;

  const paths = settings?.paths ?? {};
  const showPath = async (path?: string) => {
    if (path) await openPath(path);
  };
  const rows = [
    { label: "Agent directory", value: paths.agentDir },
    { label: "Settings file", value: paths.settingsPath },
    { label: "Sessions directory", value: paths.sessionsDir },
  ];

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">pi-gui-rs</h3>
        <Separator className="my-2" />
        <Row label="App version" hint="GUI frontend + backend">
          <span className="font-mono text-xs">{settings?.version ?? "—"}</span>
        </Row>
        <Row
          label="Agent runtime"
          hint="Core agent, tools, and sessions run on pi-rs"
        >
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Info className="size-3.5" />
            pi-coding-agent / pi-agent-core / pi-ai
          </span>
        </Row>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">
          {t("updates.title")}
        </h3>
        <Separator className="my-2" />
        <Row label={t("updates.currentVersion")} hint="pi-gui-rs">
          <span className="font-mono text-xs">{settings?.version ?? "—"}</span>
        </Row>
        <div className="flex flex-wrap items-center gap-2 py-2">
          <Button
            size="sm"
            variant="outline"
            onClick={checkUpdates}
            disabled={checking || installing}
          >
            {checking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {checking ? t("updates.checking") : t("updates.check")}
          </Button>
          {checked && !checking && !updateInfo && !updateError && (
            <span className="text-muted-foreground text-xs">
              {t("updates.upToDate")}
            </span>
          )}
        </div>

        {updateError && (
          <div className="text-destructive text-xs break-words">
            {t("updates.failed")}: {updateError}
          </div>
        )}

        {updateInfo && (
          <div className="border-hairline mt-2 rounded-lg border p-3">
            <div className="text-foreground text-sm font-medium">
              {t("updates.available", { version: updateInfo.version })}
            </div>
            {updateInfo.date && (
              <div className="text-muted-foreground mt-0.5 text-[11px]">
                {updateInfo.date}
              </div>
            )}
            {updateInfo.body && (
              <div className="mt-2">
                <div className="text-foreground text-xs font-medium">
                  {t("updates.releaseNotes")}
                </div>
                <p className="text-muted-foreground mt-1 max-h-40 overflow-y-auto text-xs whitespace-pre-wrap">
                  {updateInfo.body}
                </p>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                onClick={install}
                disabled={installing || !update}
              >
                {installing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {installing ? t("updates.installing") : t("updates.install")}
              </Button>
              {percent !== null && (
                <>
                  <div className="bg-muted h-1.5 w-40 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full transition-all"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground text-[11px] tabular-nums">
                    {t("updates.progress", { percent })}
                  </span>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">Paths</h3>
        <Separator className="my-2" />
        {rows.map((r) => (
          <Row key={r.label} label={r.label}>
            {r.value ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex max-w-[420px] items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-xs transition-colors"
                onClick={() => showPath(r.value)}
                title="Reveal in Finder"
              >
                <FolderOpen className="size-3.5 shrink-0" />
                <span className="truncate">{r.value}</span>
              </button>
            ) : (
              <span className="text-muted-foreground text-xs">—</span>
            )}
          </Row>
        ))}
      </section>
    </div>
  );
}

function SkillsTab() {
  const { activeSessionId, activeSessionCwd } = useChatContext();
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSettings((await getGeneralSettings()) as GeneralSettings);
    } catch (e) {
      console.error("getGeneralSettings failed", e);
    }
  }, []);

  // Count skills for the active session's cwd (workspace skills differ per
  // project); the process cwd would be `/` in a packaged app.
  const refreshCount = useCallback(async () => {
    try {
      const cwd = activeSessionCwd ?? (await getActiveSessionCwd());
      setSkillCount(((await listSkills(cwd)) ?? []).length);
    } catch {
      setSkillCount(null);
    }
  }, [activeSessionCwd]);

  useEffect(() => {
    refresh();
    refreshCount();
  }, [refresh, refreshCount, activeSessionId]);

  const apply = useCallback(
    async (key: keyof GeneralSettings, value: unknown) => {
      try {
        setSettings((await setGeneralSetting(key, value)) as GeneralSettings);
      } catch (e) {
        console.error(`set ${key} failed`, e);
      }
    },
    [],
  );

  const addPath = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string" || !selected) return;
    setAdding(true);
    try {
      const current = settings?.skillPaths ?? [];
      if (!current.includes(selected)) {
        await apply("skillPaths", [...current, selected]);
        await refreshCount();
      }
    } finally {
      setAdding(false);
    }
  }, [settings, apply, refreshCount]);

  const removePath = useCallback(
    async (path: string) => {
      const current = settings?.skillPaths ?? [];
      await apply(
        "skillPaths",
        current.filter((p) => p !== path),
      );
      await refreshCount();
    },
    [settings, apply, refreshCount],
  );

  if (!settings) {
    return (
      <div className="text-muted-foreground p-8 text-sm">Loading settings...</div>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">Discovery</h3>
        <Separator className="my-2" />
        <ToggleRow
          label="Skill slash commands"
          hint="Enable /skill:name commands in the composer"
          checked={settings.enableSkillCommands}
          onChange={(v) => apply("enableSkillCommands", v)}
        />
        <Row
          label="Discovered skills"
          hint="Skills in the global and workspace directories"
        >
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <BookOpen className="size-3.5" />
            {skillCount === null ? "—" : `${skillCount} skill${skillCount === 1 ? "" : "s"}`}
          </span>
        </Row>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">
          Custom skill paths
        </h3>
        <Separator className="my-2" />
        <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
          Additional directories scanned for SKILL.md files.
        </p>
        {settings.skillPaths.length === 0 ? (
          <p className="text-muted-foreground text-xs">No custom paths configured.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {settings.skillPaths.map((path) => (
              <div
                key={path}
                className="border-hairline bg-bg-surface flex items-center gap-2 rounded-md border px-3 py-2"
              >
                <span className="text-foreground/80 min-w-0 flex-1 truncate font-mono text-xs">
                  {path}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive shrink-0 rounded p-1 transition-colors"
                  onClick={() => removePath(path)}
                  title="Remove path"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          disabled={adding}
          className="text-accent hover:bg-accent/10 mt-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50"
          onClick={addPath}
        >
          <FolderPlus className="size-3.5" />
          Add path…
        </button>
      </section>
    </div>
  );
}

function ExtensionsTab() {
  const [extensions, setExtensions] = useState<
    { name: string; location: string; tools: string[]; commands: { name: string }[] }[]
  >([]);

  useEffect(() => {
    (async () => {
      try {
        setExtensions(((await listExtensions()) ?? []) as typeof extensions);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Extensions are compiled into pi-gui as Rust plugins. Built-ins are
        opt-in: enable them in <code>settings.json</code> via{" "}
        <code>{`"extensionsEnabled": { "subagent": true, "web_search": true }`}</code>{" "}
        (default off).
      </p>
      {extensions.length === 0 ? (
        <p className="text-muted-foreground text-xs">No extensions registered.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {extensions.map((e) => (
            <div
              key={e.name}
              className="border-hairline bg-bg-surface flex items-center gap-2 rounded-md border px-3 py-2"
            >
              <Puzzle className="text-muted-foreground size-3.5 shrink-0" />
              <span className="text-foreground font-mono text-sm">{e.name}</span>
              <span className="bg-muted text-foreground/70 rounded-full px-2 py-0.5 text-[10px] uppercase">
                {e.location}
              </span>
              <span className="text-muted-foreground ml-auto text-xs">
                {e.tools.length} tool{e.tools.length === 1 ? "" : "s"} ·{" "}
                {e.commands.length} command{e.commands.length === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const FIXED_KEYBINDINGS: { keys: string[]; action: string }[] = [
  { keys: ["Enter"], action: "Send message (steer while a run is active)" },
  { keys: ["Alt+Enter"], action: "Queue a follow-up while a run is active" },
  { keys: ["Shift+Enter"], action: "Insert new line" },
  { keys: ["/"], action: "Open slash commands" },
  { keys: ["@"], action: "Reference files in the workspace" },
  { keys: ["Esc"], action: "Close dialogs and search" },
];

function KeybindingsTab() {
  const { bindings, setBinding, resetAll } = useKeybindings();
  const { t } = useI18n();
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      // Prevent the app's own global shortcuts from firing while recording.
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setConflict(null);
        return;
      }
      const value = bindingFromEvent(e);
      if (!value) {
        setConflict("Hold Cmd/Ctrl (optionally with Shift/Alt)");
        return;
      }
      const other = findKeybindingConflict(recording, value);
      if (other) {
        setConflict(`Already used by “${other.label}”`);
        return;
      }
      setBinding(recording, value);
      setRecording(null);
      setConflict(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording, setBinding]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("keybindings.hint")}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setRecording(null);
            setConflict(null);
            resetAll();
          }}
        >
          {t("keybindings.resetAll")}
        </Button>
      </div>

      {conflict && <p className="text-destructive text-xs">{conflict}</p>}

      <div className="flex flex-col gap-1">
        {KEYBINDING_DEFINITIONS.map((definition) => (
          <div
            key={definition.id}
            className="flex items-center justify-between gap-6 py-1.5"
          >
            <span className="text-foreground text-sm">
              {definition.label}
            </span>
            <span className="flex items-center gap-1">
              {formatBinding(bindings[definition.id]).map((key, index) => (
                <kbd
                  key={`${key}-${index}`}
                  className="bg-bg-hover border-hairline text-ink-muted rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {key}
                </kbd>
              ))}
              <Button
                size="xs"
                variant="outline"
                className="ml-2"
                onClick={() => {
                  setConflict(null);
                  setRecording(definition.id);
                }}
              >
                {recording === definition.id ? t("keybindings.pressKeys") : t("keybindings.change")}
              </Button>
            </span>
          </div>
        ))}
      </div>

      <Separator />

      <div>
        <h3 className="text-foreground mb-2 text-sm font-medium">
          {t("keybindings.fixed")}
        </h3>
        <div className="flex flex-col gap-1">
          {FIXED_KEYBINDINGS.map((binding) => (
            <div
              key={binding.action}
              className="flex items-center justify-between gap-6 py-1.5"
            >
              <span className="text-foreground text-sm">{binding.action}</span>
              <span className="flex items-center gap-1">
                {binding.keys.map((key) => (
                  <kbd
                    key={key}
                    className="bg-bg-hover border-hairline text-ink-muted rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SettingsView({
  initialTab = "general",
}: {
  initialTab?: string;
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const { t } = useI18n();
  const active = settingsTabs.find((tab) => tab.id === activeTab);

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="shrink-0" />
        <div className="text-foreground text-sm font-medium">{t("settings.title")}</div>
      </div>

      {/* Two-panel body */}
      <div className="flex min-h-0 flex-1">
        {/* Left — tabs list */}
        <div className="border-hairline w-56 shrink-0 border-r p-3">
          <nav className="flex flex-col gap-1">
            {settingsTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors ${
                  activeTab === tab.id
                    ? "bg-accent/10 text-accent"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <span className="text-sm font-medium">{t(tab.labelKey)}</span>
                <span className="text-xs opacity-70">{t(tab.descKey)}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right — settings content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-8 py-8">
            <h2 className="text-foreground mb-1 text-lg font-medium">
              {active ? t(active.labelKey) : ""}
            </h2>
            <p className="text-muted-foreground mb-6 text-sm">
              {active ? t(active.descKey) : ""}
            </p>

            {activeTab === "models" ? (
              <ModelsSettings />
            ) : activeTab === "mcp" ? (
              <McpSettings />
            ) : activeTab === "general" ? (
              <GeneralTab />
            ) : activeTab === "skills" ? (
              <SkillsTab />
            ) : activeTab === "extensions" ? (
              <ExtensionsTab />
            ) : activeTab === "keybindings" ? (
              <KeybindingsTab />
            ) : activeTab === "about" ? (
              <AboutTab />
            ) : (
              <div className="border-hairline flex items-center justify-center rounded-lg border p-16">
                <p className="text-muted-foreground text-xs">
                  {activeTab} settings — coming soon
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
