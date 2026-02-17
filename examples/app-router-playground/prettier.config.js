module.exports = {
  arrowParens: 'always',
  semi: true,
  trailingComma: 'all',
  singleQuote: true,
  objectWrap: 'collapse',
  // pnpm doesn't support plugin autoloading
  // https://github.com/tailwindlabs/prettier-plugin-tailwindcss#installation
  plugins: ['prettier-plugin-tailwindcss'],
};
