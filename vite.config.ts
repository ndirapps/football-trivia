import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  // Vite's dev server answers CORS preflights itself, before the Worker sees
  // them, and only for localhost origins — so the native app in a simulator
  // could never POST to a local API. Off, the Worker's own CORS policy (the one
  // production runs) answers instead. Dev only; the web app is same-origin.
  server: { cors: false },
});
