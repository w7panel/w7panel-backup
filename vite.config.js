import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    proxy: {
      '/k8s-proxy': {
        target: 'http://127.0.0.1:8013',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/k8s-proxy/, ''),
      },
    },
  },
})
