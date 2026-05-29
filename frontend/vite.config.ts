import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // VITE_BASE_PATH lets the GitHub Pages workflow build under /<repo>/ without
  // affecting other hosts. Default '/' is correct for Cloudflare Pages, Vercel,
  // Netlify, a custom-domain GitHub Pages site, or local dev.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    base: env.VITE_BASE_PATH || "/",
    server: {
      allowedHosts: true, // allows cloudflared / ngrok tunnel domains
    },
  };
});
