import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { FolderOpen, FolderPlus, Info, Puzzle, Trash2, BookOpen } from "lucide-react";
import ModelsSettings from "./ModelsSettings";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  getGeneralSettings,
  listExtensions,
  listSkills,
  openPath,
  setGeneralSetting,
} from "@/api/commands";

const settingsTabs = [
  { id: "general", label: "General", desc: "Agent behavior and paths" },
  {
    id: "models",
    label: "Models",
    desc: "AI providers, default model, thinking level",
  },
  { id: "skills", label: "Skills", desc: "Skill discovery and permissions" },
  { id: "extensions", label: "Extensions", desc: "Extension management" },
  { id: "keybindings", label: "Keybindings", desc: "Keyboard shortcuts" },
  { id: "about", label: "About", desc: "Version, licenses, updates" },
];

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

function GeneralTab() {
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [saving, setSaving] = useState(false);

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
      setSaving(true);
      try {
        setSettings((await setGeneralSetting(key, value)) as GeneralSettings);
      } catch (e) {
        console.error(`set ${key} failed`, e);
      } finally {
        setSaving(false);
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

  const showPath = async (path?: string) => {
    if (path) await openPath(path);
  };

  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">Behavior</h3>
        <Separator className="my-2" />
        <ToggleRow
          label="Auto-compact long conversations"
          hint={`Reserve ${settings.compactionReserveTokens.toLocaleString()} tokens, keep ${settings.compactionKeepRecentTokens.toLocaleString()} recent`}
          checked={settings.compactionEnabled}
          onChange={(v) => apply("compactionEnabled", v)}
        />
        <ToggleRow
          label="Auto-retry failed requests"
          hint="Retry transient provider errors automatically"
          checked={settings.retryEnabled}
          onChange={(v) => apply("retryEnabled", v)}
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
        <h3 className="mb-1 text-sm font-medium text-foreground">Model</h3>
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
        <Row label="Theme" hint="Theme id passed to the agent (empty = default)">
          <Input
            className="h-8 w-40 text-xs"
            value={settings.theme ?? ""}
            placeholder="default"
            onBlur={(e) => apply("theme", e.target.value)}
          />
        </Row>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">Shell</h3>
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
      </section>
    </div>
  );
}

function AboutTab() {
  const [settings, setSettings] = useState<GeneralSettings | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setSettings((await getGeneralSettings()) as GeneralSettings);
      } catch {
        /* ignore */
      }
    })();
  }, []);

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

  useEffect(() => {
    refresh();
    (async () => {
      try {
        setSkillCount(((await listSkills()) ?? []).length);
      } catch {
        setSkillCount(null);
      }
    })();
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

  const addPath = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string" || !selected) return;
    setAdding(true);
    try {
      const current = settings?.skillPaths ?? [];
      if (!current.includes(selected)) {
        await apply("skillPaths", [...current, selected]);
      }
    } finally {
      setAdding(false);
    }
  }, [settings, apply]);

  const removePath = useCallback(
    async (path: string) => {
      const current = settings?.skillPaths ?? [];
      await apply(
        "skillPaths",
        current.filter((p) => p !== path),
      );
    },
    [settings, apply],
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
        Extensions are compiled into pi-gui as Rust plugins and are always
        available to the agent.
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
              <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] uppercase">
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

export default function SettingsView() {
  const [activeTab, setActiveTab] = useState("general");
  const active = settingsTabs.find((t) => t.id === activeTab);

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="shrink-0" />
        <div className="text-foreground text-sm font-medium">Settings</div>
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
                <span className="text-sm font-medium">{tab.label}</span>
                <span className="text-xs opacity-70">{tab.desc}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right — settings content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-8 py-8">
            <h2 className="text-foreground mb-1 text-lg font-medium">
              {active?.label}
            </h2>
            <p className="text-muted-foreground mb-6 text-sm">{active?.desc}</p>

            {activeTab === "models" ? (
              <ModelsSettings />
            ) : activeTab === "general" ? (
              <GeneralTab />
            ) : activeTab === "skills" ? (
              <SkillsTab />
            ) : activeTab === "extensions" ? (
              <ExtensionsTab />
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
