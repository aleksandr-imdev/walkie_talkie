const path = require('path');
const webpack = require('webpack');

module.exports = {
  mode: 'development', // или 'production' для продакшн-сборки
  entry: './public/js/client.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, ''),
    publicPath: '/js/',
  },
  devtool: 'inline-source-map', // Для удобства отладки
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: 'babel-loader',
      },
    ],
  },
  plugins: [
    new webpack.HotModuleReplacementPlugin(), // Для горячей перезагрузки
  ],
  devServer: {
    contentBase: path.join(__dirname, 'public'),
    compress: true,
    port: 3000,
    hot: true,
  },
};
