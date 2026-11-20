import { defineConfig } from "vite";
export default defineConfig({
  server: {
    strictPort: true,
    proxy: { "/api": process.env.STUDY_BRIDGE_URL ?? "http://127.0.0.1:4318" },
  },
  build: {
    rollupOptions: {
      input: { main: "index.html" },
      output: {
        // Cache dependencies separately from frequently changed app code.
        manualChunks: (id) =>
          id.includes("/node_modules/") ? "vendor" : undefined,
      },
    },
  },
});
