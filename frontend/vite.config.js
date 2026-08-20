import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Two entries: the patient app at /, and Dalīl's researcher portal at
// /research/. One build, one nginx, one origin — so the session cookie and the
// /api proxy work for both without a second container.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        research: resolve(__dirname, "research/index.html"),
      },
    },
  },
});
