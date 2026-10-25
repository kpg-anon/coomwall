import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [sveltekit()],
  // keep Rust errors visible
  clearScreen: false,
  // Tauri expects a fixed port; fail if it is taken
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    // .devdata holds a running WebView2 profile whose locked files crash the watcher
    watch: { ignored: ["**/src-tauri/**", "**/.devdata/**", "**/testmedia/**", "**/docs/**"] },
  },
}));
