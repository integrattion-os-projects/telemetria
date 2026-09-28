import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRoute } from "../src/route.ts";

test("troca ids dinâmicos por [id] (exemplo da spec A02)", () => {
  assert.equal(
    normalizeRoute("/projetos/abc123/paginas/xyz"),
    "/projetos/[id]/paginas/[id]",
  );
});

test("mantém segmentos estáticos comuns", () => {
  assert.equal(normalizeRoute("/settings/general"), "/settings/general");
  assert.equal(normalizeRoute("/api/docs"), "/api/docs");
});

test("normaliza uuid v4", () => {
  assert.equal(
    normalizeRoute("/entities/550e8400-e29b-41d4-a716-446655440000/next-actions"),
    "/entities/[id]/next-actions",
  );
});

test("normaliza numérico puro", () => {
  assert.equal(normalizeRoute("/tasks/12345"), "/tasks/[id]");
});

test("normaliza ObjectId de 24 hex", () => {
  assert.equal(
    normalizeRoute("/docs/507f1f77bcf86cd799439011"),
    "/docs/[id]",
  );
});

test("normaliza cuid do Prisma", () => {
  assert.equal(
    normalizeRoute("/next-actions/cly3x9k8h0000qzrmn831vxyz"),
    "/next-actions/[id]",
  );
});

test("ignora query string e hash", () => {
  assert.equal(normalizeRoute("/projetos/abc123?tab=steps#top"), "/projetos/[id]");
});

test("raiz e path vazio viram /", () => {
  assert.equal(normalizeRoute("/"), "/");
  assert.equal(normalizeRoute(""), "/");
});

test("respeita extraStaticSegments", () => {
  assert.equal(
    normalizeRoute("/artigos/foo", { extraStaticSegments: ["foo"] }),
    "/artigos/foo",
  );
  // sem a extensão, "foo" (<=4 letras, fora da stopword default) vira [id]
  assert.equal(normalizeRoute("/artigos/foo"), "/artigos/[id]");
});
