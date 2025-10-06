const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
  const { mode } = argv;

  return {
    entry: path.join(__dirname, './src/index.ts'),
    mode,
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
      path: path.resolve(__dirname, './dist'),
    },
    externals: [
      'long',
      'pino-pretty',
      'bufferutil',
      'utf-8-validate',
      'uWebSockets.js',
    ],
    optimization: {
      minimize: mode === 'production',
      minimizer: [
        new TerserPlugin({
          extractComments: false,
          terserOptions: {
            keep_classnames: true,
            keep_fnames: true,
            mangle: false,          // ⛔ prevent function name mangling
            module: true,
          },
        }),
      ],
    },
  };
};
