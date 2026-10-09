import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/ws": { target: "ws://127.0.0.1:3001", ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        setup: resolve(__dirname, "setup.html"),
        call: resolve(__dirname, "call.html"),
        sessions: resolve(__dirname, "sessions.html"),
        sessionDetail: resolve(__dirname, "session-detail.html"),
      },
    },
  },
});
