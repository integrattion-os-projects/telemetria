import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSample } from "../src/sampling.ts";

test("sampleRate 1 sempre inclui", () => {
  assert.equal(shouldSample(1, () => 0.999999), true);
});

test("sampleRate 0 nunca inclui", () => {
  assert.equal(shouldSample(0, () => 0), false);
});

test("sampleRate 0.1 inclui só abaixo do corte", () => {
  assert.equal(shouldSample(0.1, () => 0.05), true);
  assert.equal(shouldSample(0.1, () => 0.5), false);
});
