import { create } from "zustand";
import {
  getGeneralSettings,
  setGeneralSetting,
  type GeneralSettings,
} from "../api/commands";
import { showToast } from "../components/ui/toast";

interface SettingsState {
  settings: GeneralSettings | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  apply(key: keyof GeneralSettings, value: unknown): Promise<boolean>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared general-settings state. One fetch/apply path for every settings tab
 *  (general, skills, about) instead of three copies. */
export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loading: false,
  error: null,

  async refresh() {
    set({ loading: true });
    try {
      set({ settings: await getGeneralSettings(), error: null });
    } catch (error) {
      const message = errorText(error);
      set({ error: message });
      showToast({
        variant: "error",
        title: "Could not load settings",
        description: message,
      });
    } finally {
      set({ loading: false });
    }
  },

  async apply(key, value) {
    try {
      set({ settings: await setGeneralSetting(key, value), error: null });
      return true;
    } catch (error) {
      const message = errorText(error);
      set({ error: message });
      showToast({
        variant: "error",
        title: "Could not save setting",
        description: message,
      });
      return false;
    }
  },
}));
