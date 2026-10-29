import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
const motion = readFileSync(new URL('./assets/sea-motion.svg', import.meta.url), 'utf8');
export default defineConfig({ base: './', build: { target: 'es2022' }, plugins: [{ name: 'sea-loading-motion', transformIndexHtml: html => html.replace('<!-- SEA_LOADING_MOTION -->', motion) }] });
