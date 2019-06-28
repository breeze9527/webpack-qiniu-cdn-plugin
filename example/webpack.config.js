const path = require('path');

const HtmlWebpackPlugin = require('html-webpack-plugin');
const QiniuCDNPlugin = require('../');

module.exports = {
  mode: 'development',
  entry: path.join(__dirname, './src/main'),
  output: {
    path: path.join(__dirname, 'dist'),
    filename: 'sub-dir/[name].[chunkhash].js'
  },
  plugins: [
    new HtmlWebpackPlugin(),
    new QiniuCDNPlugin({
      accessKey: '__access_ket__',
      secretKey: '__secret_key__',
      cdnHost: '__host__',
      bucket: '__bucket__',
      dir: 'access',
      exclude: /\.html$/,
      expire: false,
      refresh: true,
      prefetch: true,
      dry: true
    })
  ],
  stats: 'none'
}
