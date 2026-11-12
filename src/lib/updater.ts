import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

export interface UpdateProgress {
  downloaded: number;
  total?: number;
}

export async function checkForUpdate(): Promise<{
  update: Update | null;
  info: UpdateInfo | null;
}> {
  const update = await check();
  if (!update) return { update: null, info: null };
  return {
    update,
    info: {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date,
      body: update.body,
    },
  };
}

export async function downloadAndInstall(
  update: Update,
  onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      total = event.data.contentLength;
      onProgress({ downloaded, total });
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress({ downloaded, total });
    } else {
      onProgress({ downloaded, total });
    }
  });
  // Windows' installer exits the app itself; macOS/Linux need a relaunch.
  await relaunch().catch(() => {
    /* the process may already be exiting */
  });
}
