import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    proxy: {
      ...(process.env.LOCAL_TEST === '1' ? {
        '^/k8s-proxy/api/v1/namespaces/[^/]+/services/w7panel-backup-index/proxy': {
          target: `http://127.0.0.1:${process.env.INDEX_PORT || 18023}`,
          rewrite: (path) => path.replace(/^\/k8s-proxy\/api\/v1\/namespaces\/[^/]+\/services\/w7panel-backup-index\/proxy/, ''),
        },
      } : {}),
      '/k8s-proxy': {
        target: `http://127.0.0.1:${process.env.KUBE_PROXY_PORT || 8013}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/k8s-proxy/, ''),
      },
    },
  },
})
