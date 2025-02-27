const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
  const { mode } = argv;

  return {
    entry: path.join(__dirname, './src/index.ts'),
    mode: mode,
    target: 'node',
    module: {
      rules: [
        {
          test: /\.ts?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.node$/,
          use: 'node-loader',
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, './dist')
    },
    externals: [
      'long',
      'pino-pretty',
      'bufferutil',
      'utf-8-validate',
    ],
    optimization: {
      minimizer: [
        new TerserPlugin({ extractComments: false}),
      ],
    },
  };
}