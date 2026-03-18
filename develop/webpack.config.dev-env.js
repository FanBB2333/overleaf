const { merge } = require('webpack-merge')

const base = require('./webpack.config.dev')

module.exports = merge(base, {
  devServer: {
    allowedHosts: 'auto',
    devMiddleware: {
      index: false,
    },
    proxy: [
      {
        context: pathname =>
          pathname === '/file-editor' || pathname.startsWith('/file-editor/'),
        target: 'http://file-editor:3091',
      },
      {
        context: '/terminal/socket.io/**',
        target: 'http://web:3000',
        ws: true,
      },
      {
        context: '/socket.io/**',
        target: 'http://real-time:3026',
        ws: true,
      },
      {
        context: ['!**/*.js', '!**/*.css', '!**/*.json'],
        target: 'http://web:3000',
      },
    ],
  },
})
