import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";

dotenv.config(); // .env の OPENAI_API_KEY を読み込む

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
       allowedHosts: "all", // ここを追加
  base: '/jarvis-hud-AI-/',
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
 allowedHosts: ['*']
  },
  server: {
    port: 5175,
        allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:8888",
        changeOrigin: true,
        // 必要ならパスを書き換え:
        rewrite: (p) => p.replace(/^\/api/, "/api"),
      },
    },
  },
});


