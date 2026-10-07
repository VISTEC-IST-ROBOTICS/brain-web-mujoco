import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Two pages: the simulator (index.html) and the robot summon (summon.html).
  build: {
    rollupOptions: {
      input: { main: 'index.html', summon: 'summon.html' },
    },
  },
  // The mujoco wasm glue resolves its .wasm binary via `new URL(..., import.meta.url)`;
  // Vite's dev-mode dependency pre-bundler relocates the JS without the sibling .wasm
  // file, breaking that resolution. Exclude it so it's served straight from node_modules.
  optimizeDeps: {
    exclude: ['@mujoco/mujoco'],
  },
});
