import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig({
    plugins: [svelte()],
    resolve: {
        alias: {
            '@mcu-debug/shared': resolve(__dirname, '../../../../shared/src/cockpit-protocol.ts'),
        },
    },
    build: {
        outDir: '../../../resources/cockpit',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                // Fixed names so CockpitPanel.ts can reference them without knowing the hash
                entryFileNames: 'cockpit.js',
                assetFileNames: (info) => (info.name?.endsWith('.css') ? 'cockpit.css' : '[name][extname]'),
                // Single chunk — no dynamic splitting, no extra files to allowlist in CSP
                manualChunks: () => 'cockpit',
            },
        },
    },
});
