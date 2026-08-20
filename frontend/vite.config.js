import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Three entries, one build, one origin:
//   /            the two doors
//   /tawaazun/   the patient app
//   /dalil/      the researcher portal
// Assets stay at /assets/ for all of them, so the default base is correct and
// each page's HTML can sit at whatever path nginx serves it from.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "index.html"),
        tawaazun: resolve(__dirname, "tawaazun/index.html"),
        dalil: resolve(__dirname, "dalil/index.html"),
      },
    },
  },
});
