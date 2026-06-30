import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite only exposes VITE_*-prefixed env vars to the client, so secrets in .env
// (SHELBY_PRIVATE_KEY, SHELBY_API_KEY) can never leak into the browser bundle.
export default defineConfig({
  plugins: [react()],
  envDir: "../../",
  server: { port: 5173 },
});
