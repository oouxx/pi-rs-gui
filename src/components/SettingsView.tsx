import { useCallback, useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { enter, FAST_TRANSITION } from "@/lib/motion";
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
  Bot,
  Globe,
  Settings2,
} from "lucide-react";
import ModelsSettings from "./ModelsSettings";
import McpSettings from "./McpSettings";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";
import { useChatContext } from "@/hooks/ChatProvider";
import {
  useI18n,
  type LanguagePreference,
  type TranslationKey,
} from "@/i18n";
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
  getAgentDir,
  getExtensionSettings,
  listExtensions,
  listSkills,
  openPath,
  setExtensionEnabled,
  setWebSearchConfig,
  type WebSearchSettings,
} from "@/api/commands";
import { useSettingsStore } from "@/stores/settings";

const settingsTabs = [
  { id: "general", labelKey: "settings.general" },
  { id: "models", labelKey: "settings.models" },
  { id: "mcp", labelKey: "settings.mcp" },
  { id: "skills", labelKey: "settings.skills" },
  { id: "extensions", labelKey: "settings.extensions" },
  { id: "keybindings", labelKey: "settings.keybindings" },
  { id: "about", labelKey: "settings.about" },
] as const;

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
  const { t } = useI18n();
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
            title={t("settings.remove")} aria-label={t("settings.remove")}
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
          {t("settings.add")}
        </Button>
      </div>
    </div>
  );
}

function GeneralTab() {
  const { settings, refresh, apply } = useSettingsStore();
  const { preference, setTheme } = useTheme();
  const { preference: languagePreference, setLanguage, t } = useI18n();

  useEffect(() => {
    if (!settings) void refresh();
  }, [refresh, settings]);

  if (!settings) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        {t("settings.loading")}
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
              <SelectItem value="system">{t("settings.system")}</SelectItem>
              <SelectItem value="light">{t("settings.light")}</SelectItem>
              <SelectItem value="dark">{t("settings.dark")}</SelectItem>
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
          label={t("settings.autoCompact")}
          hint={t("settings.autoCompactHint")}
          checked={settings.compactionEnabled}
          onChange={(v) => apply("compactionEnabled", v)}
        />
        <Row label={t("settings.compactionReserve")} hint={t("settings.compactionReserveHint")}>
          <NumberField
            value={settings.compactionReserveTokens}
            onCommit={(v) => apply("compactionReserveTokens", v)}
          />
        </Row>
        <Row label={t("settings.compactionKeep")} hint={t("settings.compactionKeepHint")}>
          <NumberField
            value={settings.compactionKeepRecentTokens}
            onCommit={(v) => apply("compactionKeepRecentTokens", v)}
          />
        </Row>
        <Row
          label={t("settings.steeringMode")}
          hint={t("settings.steeringModeHint")}
        >
          <Select
            value={settings.steeringMode}
            onValueChange={(v) => apply("steeringMode", v)}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one-at-a-time">{t("settings.oneAtATime")}</SelectItem>
              <SelectItem value="all">{t("settings.allAtOnce")}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label={t("settings.followUpMode")}
          hint={t("settings.followUpModeHint")}
        >
          <Select
            value={settings.followUpMode}
            onValueChange={(v) => apply("followUpMode", v)}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one-at-a-time">{t("settings.oneAtATime")}</SelectItem>
              <SelectItem value="all">{t("settings.allAtOnce")}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <ToggleRow
          label={t("settings.autoRetry")}
          hint={t("settings.autoRetryHint")}
          checked={settings.retryEnabled}
          onChange={(v) => apply("retryEnabled", v)}
        />
        <ToggleRow
          label={t("settings.cacheMissNotices")}
          hint={t("settings.cacheMissNoticesHint")}
          checked={settings.showCacheMissNotices}
          onChange={(v) => apply("showCacheMissNotices", v)}
        />
        <ToggleRow
          label={t("settings.hideThinking")}
          hint={t("settings.hideThinkingHint")}
          checked={settings.hideThinkingBlock}
          onChange={(v) => apply("hideThinkingBlock", v)}
        />
        <ToggleRow
          label={t("settings.quietStartup")}
          hint={t("settings.quietStartupHint")}
          checked={settings.quietStartup}
          onChange={(v) => apply("quietStartup", v)}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">{t("settings.model")}</h3>
        <Separator className="my-2" />
        <Row label={t("settings.defaultThinking")} hint={t("settings.defaultThinkingHint")}>
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
        <Row label={t("settings.agentTheme")} hint={t("settings.agentThemeHint")}>
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
          label={t("settings.shellPath")}
          hint={t("settings.shellPathHint")}
        >
          <Input
            className="h-8 w-64 font-mono text-xs"
            value={settings.shellPath ?? ""}
            placeholder="/bin/zsh"
            onBlur={(e) => apply("shellPath", e.target.value)}
          />
        </Row>
        <Row
          label={t("settings.shellPrefix")}
          hint={t("settings.shellPrefixHint")}
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
          label={t("settings.transport")}
          hint={t("settings.transportHint")}
        >
          <Select
            value={settings.transport}
            onValueChange={(v) => apply("transport", v)}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("settings.auto")}</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
              <SelectItem value="websocket">{t("settings.websocket")}</SelectItem>
              <SelectItem value="websocket-cached">{t("settings.websocketCached")}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label={t("settings.cacheWarming")}
          hint={t("settings.cacheWarmingHint")}
        >
          <Select
            value={settings.cacheWarming}
            onValueChange={(v) => apply("cacheWarming", v)}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t("settings.off")}</SelectItem>
              <SelectItem value="streaming">{t("settings.whileStreaming")}</SelectItem>
              <SelectItem value="idle">{t("settings.whileIdle")}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label={t("settings.defaultTrust")}
          hint={t("settings.defaultTrustHint")}
        >
          <Select
            value={settings.defaultProjectTrust}
            onValueChange={(v) => apply("defaultProjectTrust", v)}
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">{t("settings.ask")}</SelectItem>
              <SelectItem value="always">{t("settings.alwaysTrust")}</SelectItem>
              <SelectItem value="never">{t("settings.neverTrust")}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label={t("settings.externalEditor")}
          hint={t("settings.externalEditorHint")}
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
          label={t("settings.enableSkillCommands")}
          hint={t("settings.enableSkillCommandsHint")}
          checked={settings.enableSkillCommands}
          onChange={(v) => apply("enableSkillCommands", v)}
        />
        <Row label={t("settings.skillPaths")} hint={t("settings.skillPathsHint")}>
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
        <Row label={t("settings.promptPaths")} hint={t("settings.promptPathsHint")}>
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
  const { settings, refresh } = useSettingsStore();
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
    if (!settings) void refresh();
  }, [refresh, settings]);

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

  const paths = settings?.paths;
  const showPath = async (path?: string) => {
    if (path) await openPath(path);
  };
  const rows = [
    { label: t("settings.agentDir"), value: paths?.agentDir },
    { label: t("settings.settingsFile"), value: paths?.settingsPath },
    { label: t("settings.sessionsDir"), value: paths?.sessionsDir },
  ];

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">pi-gui-rs</h3>
        <Separator className="my-2" />
        <Row label={t("settings.appVersion")} hint={t("settings.appVersionHint")}>
          <span className="font-mono text-xs">{settings?.version ?? "—"}</span>
        </Row>
        <Row
          label={t("settings.agentRuntime")}
          hint={t("settings.agentRuntimeHint")}
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
        <h3 className="mb-1 text-sm font-medium text-foreground">{t("settings.paths")}</h3>
        <Separator className="my-2" />
        {rows.map((r) => (
          <Row key={r.label} label={r.label}>
            {r.value ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex max-w-[420px] items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-xs transition-colors"
                onClick={() => showPath(r.value)}
                title={t("settings.revealInFinder")}
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
  const { settings, refresh, apply } = useSettingsStore();
  const { t } = useI18n();
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

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
    if (!settings) void refresh();
    refreshCount();
  }, [refresh, refreshCount, activeSessionId, settings]);

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
      <div className="text-muted-foreground p-8 text-sm">{t("settings.loading")}</div>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">{t("settings.discovery")}</h3>
        <Separator className="my-2" />
        <ToggleRow
          label={t("settings.skillSlashCommands")}
          hint={t("settings.skillSlashCommandsHint")}
          checked={settings.enableSkillCommands}
          onChange={(v) => apply("enableSkillCommands", v)}
        />
        <Row
          label={t("settings.discoveredSkills")}
          hint={t("settings.discoveredSkillsHint")}
        >
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <BookOpen className="size-3.5" />
            {skillCount === null ? "—" : `${skillCount} skill${skillCount === 1 ? "" : "s"}`}
          </span>
        </Row>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">
          {t("settings.customSkillPaths")}
        </h3>
        <Separator className="my-2" />
        <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
          {t("settings.customSkillPathsHint")}
        </p>
        {settings.skillPaths.length === 0 ? (
          <p className="text-muted-foreground text-xs">No custom paths configured.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {settings.skillPaths.map((path) => (
              <div
                key={path}
                className="border-hairline bg-card flex items-center gap-2 rounded-md border px-3 py-2"
              >
                <span className="text-foreground/80 min-w-0 flex-1 truncate font-mono text-xs">
                  {path}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive shrink-0 rounded p-1 transition-colors"
                  onClick={() => removePath(path)}
                  title={t("settings.removePath")} aria-label={t("settings.removePath")}
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
          className="text-primary hover:bg-primary/10 mt-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50"
          onClick={addPath}
        >
          <FolderPlus className="size-3.5" />
          {t("settings.addPath")}
        </button>
      </section>
    </div>
  );
}

interface ExtensionInfo {
  name: string;
  location: string;
  tools: string[];
  commands: { name: string; description?: string }[];
  enabled: boolean;
}

const EXTENSION_META: Record<
  string,
  { icon: ReactNode; titleKey: TranslationKey; descriptionKey: TranslationKey }
> = {
  subagent: {
    icon: <Bot className="size-3.5" />,
    titleKey: "extensions.subagentTitle",
    descriptionKey: "extensions.subagentDescription",
  },
  web_search: {
    icon: <Globe className="size-3.5" />,
    titleKey: "extensions.webSearchTitle",
    descriptionKey: "extensions.webSearchDescription",
  },
};

function ExtensionsTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [webSearch, setWebSearch] = useState<WebSearchSettings | null>(null);
  const [provider, setProvider] = useState("auto");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [ollamaHost, setOllamaHost] = useState("");
  const [saving, setSaving] = useState(false);
  const [agentDir, setAgentDir] = useState("");
  const [showWebSearchSettings, setShowWebSearchSettings] = useState(false);

  const applyWebSearch = useCallback((settings: WebSearchSettings) => {
    setWebSearch(settings);
    setProvider(settings.provider || "auto");
    setBaseUrl(settings.deepseekBaseUrl);
    setOllamaHost(settings.ollamaHost);
    setApiKey("");
    setClearKey(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [items, settings, dir] = await Promise.all([
        listExtensions(),
        getExtensionSettings(),
        getAgentDir(),
      ]);
      setExtensions((items ?? []) as ExtensionInfo[]);
      applyWebSearch(settings.webSearch);
      setAgentDir(dir ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [applyWebSearch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (extension: ExtensionInfo, enabled: boolean) => {
      setBusy(extension.name);
      try {
        const result = await setExtensionEnabled(extension.name, enabled);
        if (result.applied === false && result.warning) {
          toast({
            variant: "error",
            title: t("extensions.updateFailed"),
            description: result.warning,
          });
        } else {
          toast({
            variant: "success",
            title: `${extension.name} ${t(
              enabled ? "extensions.enabled" : "extensions.disabled",
            )}`,
          });
        }
        await refresh();
      } catch (e) {
        toast({
          variant: "error",
          title: t("extensions.updateFailed"),
          description: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setBusy(null);
      }
    },
    [refresh, t, toast],
  );

  const saveWebSearch = useCallback(async () => {
    setSaving(true);
    try {
      const result = await setWebSearchConfig({
        provider,
        deepseekBaseUrl: baseUrl.trim() || null,
        deepseekApiKey: apiKey.trim() || null,
        clearDeepseekApiKey: clearKey,
        ollamaHost: ollamaHost.trim() || null,
      });
      applyWebSearch(result.webSearch);
      if (result.applied === false && result.warning) {
        toast({
          variant: "error",
          title: t("extensions.saveFailed"),
          description: result.warning,
        });
      } else {
        toast({ variant: "success", title: t("extensions.saved") });
      }
    } catch (e) {
      toast({
        variant: "error",
        title: t("extensions.saveFailed"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }, [
    provider,
    baseUrl,
    apiKey,
    clearKey,
    ollamaHost,
    applyWebSearch,
    t,
    toast,
  ]);

  const openAgentsFolder = useCallback(async () => {
    if (!agentDir) return;
    try {
      // Prefer the agents subfolder; fall back to the agent dir when it has
      // not been created yet.
      await openPath(`${agentDir}/agents`).catch(() => openPath(agentDir));
    } catch (e) {
      toast({
        variant: "error",
        title: t("common.openFailed"),
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [agentDir, t, toast]);

  if (loading) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        {t("common.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-destructive text-xs">{error}</p>
        <Button size="sm" variant="outline" onClick={refresh}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-xs leading-relaxed">
        {t("settings.extensionsHint")}
      </p>
      {extensions.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("settings.noExtensions")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {extensions.map((extension) => {
            const meta = EXTENSION_META[extension.name];
            const isWebSearch = extension.name === "web_search";
            const backend =
              provider === "auto"
                ? webSearch?.hasDeepSeekKey
                  ? "DeepSeek"
                  : "Ollama"
                : provider === "deepseek"
                  ? "DeepSeek"
                  : "Ollama";
            return (
              <div
                key={extension.name}
                className={`border-hairline bg-card flex flex-col gap-2 rounded-lg border p-3 ${
                  extension.enabled ? "" : "opacity-70"
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <span className="bg-muted text-muted-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md">
                    {meta?.icon ?? <Puzzle className="size-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground text-sm font-medium">
                        {meta ? t(meta.titleKey) : extension.name}
                      </span>
                      {isWebSearch && webSearch && (
                        <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px]">
                          {backend}
                        </span>
                      )}
                    </div>
                    {meta && (
                      <p className="text-muted-foreground mt-0.5 text-[11px] leading-relaxed">
                        {t(meta.descriptionKey)}
                      </p>
                    )}
                  </div>
                  <Checkbox
                    className="mt-0.5"
                    checked={extension.enabled}
                    disabled={busy === extension.name}
                    onCheckedChange={(checked) =>
                      toggle(extension, checked === true)
                    }
                    aria-label={t("extensions.enableAria", {
                      name: extension.name,
                    })}
                  />
                </div>

                {extension.tools.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 pl-[2.125rem]">
                    {extension.tools.map((tool) => (
                      <span
                        key={tool}
                        className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                )}

                {extension.commands.map((command) => (
                  <div
                    key={command.name}
                    className="flex items-baseline gap-2 pl-[2.125rem] text-[11px]"
                  >
                    <span className="text-foreground/90 font-mono">
                      /{command.name}
                    </span>
                    {command.description && (
                      <span className="text-muted-foreground">
                        {command.description}
                      </span>
                    )}
                  </div>
                ))}

                {extension.name === "subagent" && (
                  <div className="flex flex-col gap-1 pl-[2.125rem]">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span
                        className="text-muted-foreground truncate font-mono"
                        title={agentDir ? `${agentDir}/agents` : ""}
                      >
                        {agentDir ? `${agentDir}/agents` : "—"}
                      </span>
                      <button
                        type="button"
                        onClick={openAgentsFolder}
                        disabled={!agentDir}
                        className="text-primary hover:underline disabled:opacity-50"
                      >
                        {t("extensions.openAgentsFolder")}
                      </button>
                    </div>
                    <p className="text-subtle-foreground text-[10px] leading-relaxed">
                      {t("extensions.subagentHint")}
                    </p>
                  </div>
                )}

                {isWebSearch && webSearch && (
                  <div className="flex flex-col gap-2 pl-[2.125rem]">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-[11px]">
                        {t("extensions.backend", { name: backend })}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() =>
                          setShowWebSearchSettings((value) => !value)
                        }
                      >
                        <Settings2 className="size-3" />
                        {showWebSearchSettings
                          ? t("common.collapse")
                          : t("extensions.configure")}
                      </Button>
                    </div>
                    {provider === "deepseek" && !webSearch.hasDeepSeekKey && (
                      <p className="text-warning text-[11px]">
                        {t("extensions.missingKey")}
                      </p>
                    )}
                    {showWebSearchSettings && (
                      <div className="border-hairline flex flex-col gap-2 border-t pt-2">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-muted-foreground text-[11px]">
                              {t("extensions.provider")}
                            </span>
                            <Select value={provider} onValueChange={setProvider}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="auto">
                                  {t("extensions.providerAuto")}
                                </SelectItem>
                                <SelectItem value="deepseek">
                                  {t("extensions.providerDeepseek")}
                                </SelectItem>
                                <SelectItem value="ollama">
                                  {t("extensions.providerOllama")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </label>
                          {provider !== "ollama" && (
                            <label className="flex flex-col gap-1">
                              <span className="text-muted-foreground text-[11px]">
                                {t("extensions.deepseekBaseUrl")}
                              </span>
                              <Input
                                value={baseUrl}
                                onChange={(e) => setBaseUrl(e.target.value)}
                                placeholder="https://api.deepseek.com"
                                className="h-8 text-xs"
                              />
                            </label>
                          )}
                        </div>
                        {provider !== "ollama" && (
                          <div className="flex flex-col gap-1">
                            <span className="text-muted-foreground text-[11px]">
                              {t("extensions.deepseekApiKey")}
                            </span>
                            <div className="flex items-center gap-2">
                              <Input
                                type="password"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder={
                                  webSearch.hasDeepSeekKey
                                    ? t("extensions.deepseekKeySet")
                                    : t("extensions.deepseekKeyPlaceholder")
                                }
                                className="h-8 flex-1 text-xs"
                              />
                              {webSearch.hasDeepSeekKey && (
                                <label className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[11px] select-none">
                                  <Checkbox
                                    checked={clearKey}
                                    onCheckedChange={(checked) =>
                                      setClearKey(checked === true)
                                    }
                                  />
                                  {t("extensions.clearKey")}
                                </label>
                              )}
                            </div>
                            <span className="text-subtle-foreground text-[10px]">
                              {t("extensions.deepseekKeyHint")}
                            </span>
                          </div>
                        )}
                        {provider !== "deepseek" && (
                          <label className="flex flex-col gap-1">
                            <span className="text-muted-foreground text-[11px]">
                              {t("extensions.ollamaHost")}
                            </span>
                            <Input
                              value={ollamaHost}
                              onChange={(e) => setOllamaHost(e.target.value)}
                              placeholder="http://localhost:11434"
                              className="h-8 text-xs"
                            />
                          </label>
                        )}
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={saveWebSearch}
                            disabled={saving}
                          >
                            {saving && (
                              <Loader2 className="size-3.5 animate-spin" />
                            )}
                            {t("extensions.saveSettings")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const KEYBINDING_LABEL_KEYS: Record<string, TranslationKey> = {
  newThread: "keybindings.newThread",
  focusComposer: "keybindings.focusComposer",
  openSettings: "keybindings.openSettings",
  findInChat: "keybindings.findInChat",
  toggleTerminal: "keybindings.toggleTerminal",
  cycleModel: "keybindings.cycleModel",
  cycleModelBackward: "keybindings.cycleModelBackward",
};

const FIXED_KEYBINDINGS: { keys: string[]; actionKey: TranslationKey }[] = [
  { keys: ["Enter"], actionKey: "keybindings.fixedSend" },
  { keys: ["Alt+Enter"], actionKey: "keybindings.fixedQueue" },
  { keys: ["Shift+Enter"], actionKey: "keybindings.fixedNewline" },
  { keys: ["/"], actionKey: "keybindings.fixedSlash" },
  { keys: ["@"], actionKey: "keybindings.fixedFiles" },
  { keys: ["Esc"], actionKey: "keybindings.fixedEsc" },
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
        setConflict(t("keybindings.holdMod"));
        return;
      }
      const other = findKeybindingConflict(recording, value);
      if (other) {
        setConflict(
          t("keybindings.conflict", {
            name: KEYBINDING_LABEL_KEYS[other.id]
              ? t(KEYBINDING_LABEL_KEYS[other.id])
              : other.label,
          }),
        );
        return;
      }
      setBinding(recording, value);
      setRecording(null);
      setConflict(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording, setBinding, t]);

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
              {KEYBINDING_LABEL_KEYS[definition.id]
                ? t(KEYBINDING_LABEL_KEYS[definition.id])
                : definition.label}
            </span>
            <span className="flex items-center gap-1">
              {formatBinding(bindings[definition.id]).map((key, index) => (
                <kbd
                  key={`${key}-${index}`}
                  className="bg-accent border-hairline text-muted-foreground rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
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
              key={binding.actionKey}
              className="flex items-center justify-between gap-6 py-1.5"
            >
              <span className="text-foreground text-sm">
                {t(binding.actionKey)}
              </span>
              <span className="flex items-center gap-1">
                {binding.keys.map((key) => (
                  <kbd
                    key={key}
                    className="bg-accent border-hairline text-muted-foreground rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
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
                className={`rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                  activeTab === tab.id
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </nav>
        </div>

        {/* Right — settings content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-8 py-8">
            <motion.div
              key={activeTab}
              {...enter}
              transition={FAST_TRANSITION}
            >
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
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}
