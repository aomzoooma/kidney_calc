import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: {
      '/experimental': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        configure: proxy => proxy.on('proxyReq', request => request.setHeader('origin', 'http://127.0.0.1:8000')),
      },
    },
  },
})
