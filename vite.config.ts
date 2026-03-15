import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    ignorePatterns: ["tests/fixtures/ecosystem/**", "examples/**"],
  },
  lint: {
    ignorePatterns: ["fixtures/ecosystem/**", "tests/fixtures/ecosystem/**", "examples/**"],
    // TODO: Enable typeAware and typeCheck later
    // options: {
    //   typeAware: true,
    //   typeCheck: true,
    // },
  },
});
