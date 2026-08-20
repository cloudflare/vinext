---
"vinext": minor
---

Support the React Compiler through `vinext({ react: { compiler: true } })`.

The option is forwarded to `@vitejs/plugin-react` 6.1+, which runs the compiler via the optional `oxc-transform-react` package. `vinext:jsx-in-js` now runs before the React plugin so that JSX in plain `.js` files keeps working when the compiler is enabled.
