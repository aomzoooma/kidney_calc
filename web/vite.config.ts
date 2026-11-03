import { defineConfig } from 'vite'
import { allowsSameOriginApiProxy } from './src/proxySecurity'

export default defineConfig({
  plugins: [{
    name: 'restrict-experimental-origin',
    configureServer(server) {
      for (const prefix of ['/experimental', '/auth']) {
        server.middlewares.use(prefix, (request, response, next) => {
          if (!allowsSameOriginApiProxy(request.headers as Record<string, string | undefined>)) {
            response.statusCode = 403
            response.end('Origin not allowed')
            return
          }
          next()
        })
      }
    },
  }],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/experimental': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        configure: proxy => proxy.on('proxyReq', (proxyRequest, incomingRequest) => {
          proxyRequest.setHeader('origin', 'http://127.0.0.1:8000')
          const fetchSite = incomingRequest.headers['sec-fetch-site']
          if (fetchSite) proxyRequest.setHeader('sec-fetch-site', fetchSite)
        }),
      },
      '/auth': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        configure: proxy => proxy.on('proxyReq', (proxyRequest, incomingRequest) => {
          proxyRequest.setHeader('origin', 'http://127.0.0.1:8000')
          const fetchSite = incomingRequest.headers['sec-fetch-site']
          if (fetchSite) proxyRequest.setHeader('sec-fetch-site', fetchSite)
        }),
      },
    },
  },
})
