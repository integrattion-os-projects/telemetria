import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: false,
  clean: true,
  minify: true,
  target: "es2020",
  // web-vitals nunca entra no chunk do núcleo — vitals.ts usa import()
  // dinâmico e o splitting do tsup separa isso automaticamente pro ESM.
});
