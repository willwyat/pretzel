import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Dev-only: /settings has no static file; rewrite to / so Vite serves index.html (SPA). */
function settingsSpaFallback(): Plugin {
  return {
    name: "settings-spa-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (req.method === "GET" && /^\/settings(\/.*)?$/.test(pathname)) {
          const q = req.url?.includes("?")
            ? "?" + req.url.split("?").slice(1).join("?")
            : "";
          req.url = "/" + q;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), settingsSpaFallback()],
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
      "/pretzel/admin": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
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
