import { test } from "node:test";
import assert from "node:assert/strict";

// INTG-0139 A21 — achado B1 do A20: `init()` só roda depois de `load` +
// `requestIdleCallback`, mas isso NÃO garante que o FCP já tenha acontecido
// (apps com gate de sessão, ex. LoginGate, atrasam o primeiro paint de
// verdade pra depois disso). A versão antiga lia `getEntriesByType('paint')`
// uma única vez e, sem a entrada, gravava `nowMs()` (o instante do `init()`)
// como se fosse o FCP.
//
// Este arquivo usa um PerformanceObserver fake que NÃO entrega o FCP na hora
// (diferente do shim de index.test.ts/navigation.test.ts, que entrega
// sincronamente pra simular `buffered: true` com FCP já ocorrido) — aqui
// simulamos o FCP chegando DEPOIS, via `deliverFcp()` chamado manualmente
// pelo teste, pra provar que a lib espera o evento real em vez de aproximar.
const g = globalThis as Record<string, unknown>;
if (!("document" in g)) {
  g.document = {
    prerendering: false,
    readyState: "complete",
    visibilityState: "visible",
    wasDiscarded: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (!("self" in g)) g.self = globalThis;
if (!("addEventListener" in g)) g.addEventListener = () => {};
if (!("removeEventListener" in g)) g.removeEventListener = () => {};

type FakeEntry = { name: string; startTime: number };
type FakeList = { getEntries: () => FakeEntry[] };

let pendingPaintCallback: ((list: FakeList) => void) | null = null;

// Sobrescreve sempre (o Node já tem um PerformanceObserver nativo que nunca
// entrega 'paint' de verdade — ver o mesmo comentário nos outros arquivos de
// teste).
class DeferredPerformanceObserver {
  static supportedEntryTypes: string[] = [];
  #callback: (list: FakeList) => void;
  constructor(cb: (list: FakeList) => void) {
    this.#callback = cb;
  }
  observe(options?: { type?: string }): void {
    if (options?.type === "paint") {
      pendingPaintCallback = this.#callback; // NÃO entrega ainda — só guarda
    }
  }
  disconnect(): void {
    pendingPaintCallback = null;
  }
  takeRecords(): unknown[] {
    return [];
  }
}
g.PerformanceObserver = DeferredPerformanceObserver;

function deliverFcp(startTime: number): void {
  if (!pendingPaintCallback) throw new Error("nenhum observer de 'paint' pendente — teste está errado");
  const cb = pendingPaintCallback;
  pendingPaintCallback = null;
  cb({ getEntries: () => [{ name: "first-contentful-paint", startTime }] });
}

const telemetria = await import("../dist/index.js");

interface CapturedCall {
  url: string;
  body: string;
}

function withFakeFetch<T>(run: (calls: CapturedCall[]) => T): T {
  const calls: CapturedCall[] = [];
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  try {
    return run(calls);
  } finally {
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  }
}

test("T1 do boot espera o FCP real em vez de aproximar com o instante do init() — regressão do achado B1 (A20)", () => {
  // Cenário do A20: LoginGate/gate de sessão atrasa o FCP pra bem depois do
  // init() (ex.: 800ms). Sem PerformanceObserver, a lib gravaria T1 ~= 0
  // (instante do init()). Com a correção, T1 só é gravado quando o FCP
  // "chega" de verdade, com o valor real do FCP.
  telemetria.__resetForTest();
  pendingPaintCallback = null;

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a21-b1",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });

    // Sem FCP ainda: T1 não deve ter sido gravado no buffer (T4 já foi,
    // recordInitialMarks grava T4 de forma síncrona — só T1 espera o FCP).
    telemetria.flush();
    const marksAntesDoFcp = calls.flatMap(
      (c) => (JSON.parse(c.body) as { marks: Array<{ name: string }> }).marks,
    );
    assert.ok(
      !marksAntesDoFcp.some((m) => m.name === "T1"),
      "T1 não deveria ter sido gravado ainda — está esperando o FCP real, não inventou nada",
    );

    // FCP "chega" 800ms depois (valor real que o navegador reportaria).
    deliverFcp(800.4);
    telemetria.flush();

    const payload = JSON.parse(calls[calls.length - 1].body) as {
      marks: Array<{ name: string; timestamp: number }>;
    };
    const t1 = payload.marks.find((m) => m.name === "T1");
    assert.ok(t1, "T1 precisa existir depois que o FCP chegou");
    assert.equal(
      t1!.timestamp,
      800.4,
      "T1 precisa ser exatamente o startTime do FCP real, não uma aproximação do instante do init()",
    );
  });
});

test("T1 do boot é gravado na hora se o FCP já tinha acontecido antes do init()", () => {
  // Caso normal: FCP já ocorreu por 'buffered: true' entrega no ato.
  telemetria.__resetForTest();
  pendingPaintCallback = null;

  // Sobrescreve temporariamente pra simular buffered:true entregando já.
  class ImmediatePerformanceObserver {
    static supportedEntryTypes: string[] = [];
    #callback: (list: FakeList) => void;
    constructor(cb: (list: FakeList) => void) {
      this.#callback = cb;
    }
    observe(options?: { type?: string }): void {
      if (options?.type === "paint") {
        this.#callback({ getEntries: () => [{ name: "first-contentful-paint", startTime: 42.1 }] });
      }
    }
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  }
  const original = g.PerformanceObserver;
  g.PerformanceObserver = ImmediatePerformanceObserver;

  try {
    withFakeFetch((calls) => {
      telemetria.init({
        entitySlug: "teste-a21-b1-imediato",
        endpoint: "http://localhost/telemetria-teste",
        sampleRate: 1,
        batchSize: 1000,
      });
      telemetria.flush();

      const payload = JSON.parse(calls[0].body) as {
        marks: Array<{ name: string; timestamp: number }>;
      };
      const t1 = payload.marks.find((m) => m.name === "T1");
      assert.ok(t1, "T1 precisa existir");
      assert.equal(t1!.timestamp, 42.1, "T1 é o startTime do FCP já ocorrido, entregue na hora");
    });
  } finally {
    g.PerformanceObserver = original;
  }
});
