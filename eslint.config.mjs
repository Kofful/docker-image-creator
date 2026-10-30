import js from "@eslint/js";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/dist-test/**", "**/generated/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs["flat/recommended"],
  {
    files: ["**/*.vue"],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    rules: {
      "no-undef": "off",
      "vue/multi-word-component-names": "off",
      "vue/html-self-closing": ["error", { html: { void: "always" } }],
      "vue/max-attributes-per-line": "off",
      "vue/html-closing-bracket-newline": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/multiline-html-element-content-newline": "off",
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    files: ["**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
