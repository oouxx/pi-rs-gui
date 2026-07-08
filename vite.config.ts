import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), react()],

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // pi-gui SDK stubs — Rollup needs real files, not just ambient declarations
      "@pi-gui/pi-sdk-driver/custom-provider-types": path.resolve(__dirname, "./src/ambient-stub.ts"),
      "@pi-gui/pi-sdk-driver": path.resolve(__dirname, "./src/ambient-stub.ts"),
      "@pi-gui/session-driver": path.resolve(__dirname, "./src/ambient-stub.ts"),
      "@pi-gui/session-driver/types": path.resolve(__dirname, "./src/ambient-stub.ts"),
      "@pi-gui/session-driver/runtime-types": path.resolve(__dirname, "./src/ambient-stub.ts"),
    },
  },
}));
