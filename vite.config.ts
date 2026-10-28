import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
const logo = readFileSync(new URL('./assets/dk-loading.svg', import.meta.url), 'utf8');
export default defineConfig({ base: './', build: { target: 'es2022' }, plugins: [{ name: 'dk-logo', transformIndexHtml: html => html.replace('<!-- DK_LOADING_LOGO -->', logo) }] });
