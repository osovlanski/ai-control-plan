import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: { exclude: ["e2e/**", "node_modules/**"] },
  server: {
    host: "127.0.0.1",
    port: 5176,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4176",
        changeOrigin: true,
      },
    },
  },
});
