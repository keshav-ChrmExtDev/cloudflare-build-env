import { defineConfig } from "wxt";

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
	srcDir: "src",
	modules: ["@wxt-dev/module-svelte"],
	manifest: {
		name: "Build env",
		description:
			"Paste a .env file and sync build variables and secrets to Cloudflare Workers.",
		permissions: ["storage"],
		host_permissions: ["https://dash.cloudflare.com/*"],
		action: {
			default_title: "Build env",
		},
	},
});
