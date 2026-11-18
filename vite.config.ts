import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'
import { appConfig } from './config/app.ts'

// https://vite.dev/config/
export default defineConfig({
  base: appConfig.basePath,
  // Loopback-only development service. Never proxy local credentials to production.
  server: {
    proxy: { '/api/v1': { target: 'http://127.0.0.1:4317', changeOrigin: false } },
    watch: { ignored: ['**/playwright-report/**', '**/test-results/**', '**/test-results-sync/**', '**/.dev/**'] },
  },
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    injectRegister: false,
    scope: appConfig.basePath,
    manifest: {
      id: appConfig.basePath,
      name: appConfig.displayName,
      short_name: appConfig.displayName,
      start_url: appConfig.basePath,
      scope: appConfig.basePath,
      display: 'standalone',
      background_color: '#f5f5ef',
      theme_color: '#254d3b',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    },
    workbox: {
      cacheId: appConfig.id,
      cleanupOutdatedCaches: true,
      navigateFallback: `${appConfig.basePath}index.html`,
      navigateFallbackAllowlist: [new RegExp(`^${appConfig.basePath}`)],
      navigateFallbackDenylist: [/\/[^/?]+\.[^/]+$/],
      globPatterns: ['**/*.{js,css,html,png,webmanifest}'],
      runtimeCaching: [],
    },
    devOptions: { enabled: false },
  })],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'config/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
