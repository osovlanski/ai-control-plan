import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "AGENT_PLANE_");
  return {
    plugins: [react()],
    test: { exclude: ["e2e/**", "node_modules/**"] },
    server: {
      host: "127.0.0.1",
      port: Number(env.AGENT_PLANE_WEB_PORT ?? 5176),
      proxy: {
        "/api": {
          target: env.AGENT_PLANE_API_URL ?? "http://127.0.0.1:4176",
          changeOrigin: true,
        },
      },
    },
  };
});
