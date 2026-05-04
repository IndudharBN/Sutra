import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

function tradeServerPlugin() {
  let child: ChildProcess | null = null;
  return {
    name: 'vite-plugin-trade-server',
    configureServer() {
      if (child) return;
      child = spawn('node', ['trade-server.mjs'], { stdio: 'inherit' });
      child.on('error', () => {
        // EADDRINUSE = already running from a previous session; safe to ignore
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tradeServerPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    hmr: process.env.DISABLE_HMR !== 'true',
    proxy: {
      '/api/trades': {
        target: 'http://localhost:3009',
        changeOrigin: true,
      },
    },
  },
});
