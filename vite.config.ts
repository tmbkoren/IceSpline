/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base must match the GitHub Pages subpath (case-sensitive): /<repo>/
export default defineConfig({
  base: '/IceSpline/',
  plugins: [react()],
  test: {
    // core/ + differential tests are DOM-free; switch to 'jsdom' when React
    // component tests arrive (then add `npm i -D jsdom`).
    environment: 'node',
  },
});
