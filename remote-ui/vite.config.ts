import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
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
  plugins: [
    react(),
    settingsSpaFallback(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [
        "pwa-192.png",
        "pwa-512.png",
        "apple-touch-icon.png",
        "fonts/*.ttf",
        "icons/*.svg",
      ],
      manifest: {
        name: "Pretzel remote",
        short_name: "Pretzel",
        description:
          "Home remote for TV, Pi speaker, and LIFX on your LAN (same Wi‑Fi).",
        theme_color: "#ececec",
        background_color: "#ececec",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [
          /^\/tv\//,
          /^\/pretzel\//,
          /^\/lifx\//,
        ],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,ttf}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              /^\/(tv|pretzel|lifx)(\/|$)/.test(url.pathname),
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
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
