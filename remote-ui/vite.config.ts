import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/tv": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (p) => "/tv" + p,
      },
      "/pretzel": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        rewrite: (p) => "/pretzel" + p,
      },
      "/lifx": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        rewrite: (p) => "/lifx" + p,
      },
    },
  },
});
