import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBuffer } from "../src/buffer.ts";

test("não flusha antes do batchSize", () => {
  const flushes: number[] = [];
  const buffer = new EventBuffer({
    batchSize: 5,
    maxEventsPerSession: 100,
    onFlush: (batch) => flushes.push(batch.length),
  });

  for (let i = 0; i < 4; i++) {
    buffer.push({ name: "T1", timestamp: i });
  }

  assert.equal(flushes.length, 0);
  assert.equal(buffer.pending, 4);
});

test("flusha em lote ao atingir batchSize — nunca 1 por 1", () => {
  const flushes: number[][] = [];
  const buffer = new EventBuffer({
    batchSize: 3,
    maxEventsPerSession: 100,
    onFlush: (batch) => flushes.push(batch.map((e) => e.name)),
  });

  for (let i = 0; i < 7; i++) {
    buffer.push({ name: `e${i}`, timestamp: i });
  }

  // 7 eventos, batch 3: dois lotes de 3 flushados automaticamente, 1 pendente
  assert.equal(flushes.length, 2);
  assert.equal(flushes[0].length, 3);
  assert.equal(flushes[1].length, 3);
  assert.equal(buffer.pending, 1);
});

test("flush manual esvazia o que sobrou", () => {
  const flushes: number[] = [];
  const buffer = new EventBuffer({
    batchSize: 20,
    maxEventsPerSession: 100,
    onFlush: (batch) => flushes.push(batch.length),
  });

  buffer.push({ name: "a", timestamp: 1 });
  buffer.push({ name: "b", timestamp: 2 });
  assert.equal(flushes.length, 0);

  buffer.flush();
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0], 2);
  assert.equal(buffer.pending, 0);
});

test("flush em buffer vazio não chama onFlush", () => {
  let called = false;
  const buffer = new EventBuffer({
    onFlush: () => {
      called = true;
    },
  });
  buffer.flush();
  assert.equal(called, false);
});

test("teto de eventos por sessão descarta em silêncio, sem flood", () => {
  const flushes: number[][] = [];
  const buffer = new EventBuffer({
    batchSize: 1000, // nunca flusha por batch nesse teste
    maxEventsPerSession: 5,
    onFlush: (batch) => flushes.push(batch.map((e) => e.name)),
  });

  for (let i = 0; i < 50; i++) {
    buffer.push({ name: `e${i}`, timestamp: i });
  }

  assert.equal(buffer.accepted, 5);
  assert.equal(buffer.pending, 5);
  assert.equal(buffer.isAtCap, true);

  buffer.flush();
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].length, 5);

  // depois do cap, push subsequente continua sendo descartado
  buffer.push({ name: "depois-do-cap", timestamp: 999 });
  assert.equal(buffer.accepted, 5);
  assert.equal(buffer.pending, 0);
});
