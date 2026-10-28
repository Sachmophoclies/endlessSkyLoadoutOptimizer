import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" lets the site work from any GitHub Pages sub-path.
export default defineConfig({
	base: "./",
	plugins: [react()],
	worker: { format: "es" },
});
