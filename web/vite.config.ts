import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [{
    name: 'restrict-experimental-origin',
    configureServer(server) {
      server.middlewares.use('/experimental', (request, response, next) => {
        const origin = request.headers.origin
        if (origin && origin !== `http://${request.headers.host}`) {
          response.statusCode = 403
          response.end('Origin not allowed')
          return
        }
        next()
      })
    },
  }],
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
