const path = require('path');

module.exports = {
  mode: 'production',
  entry: './public/js/client.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'public/js'), // Сохраняем файл в папке public
    publicPath: '/js/',
  },
  devtool: false,
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: 'babel-loader',
      },
    ],
  },
  plugins: [],
};
