import { test } from "node:test";
import assert from "node:assert/strict";

// `init()` (src/index.ts) dispara `observeVitals()` (src/vitals.ts) de forma
// assíncrona e não-aguardada (`void observeVitals(...)`), que importa
// `web-vitals` de verdade — biblioteca que assume um DOM real (`document`,
// `PerformanceObserver`) e não tem guard de ambiente, diferente do resto do
// módulo. Isso é comportamento pré-existente e fora do escopo desta correção
// (o achado A04 era sobre mark() antes de init(), não sobre vitals rodando
// sem DOM); o shim mínimo abaixo é instalado ANTES de importar o módulo e
// fica ativo durante todo o processo de teste — nada de instalar/desinstalar
// por teste, porque `observeVitals` roda em microtask e sobrevive ao retorno
// síncrono do teste que a disparou.
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
if (!("PerformanceObserver" in g)) {
  class FakePerformanceObserver {
    static supportedEntryTypes: string[] = [];
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  }
  g.PerformanceObserver = FakePerformanceObserver;
}
if (!("self" in g)) g.self = globalThis;
if (!("addEventListener" in g)) g.addEventListener = () => {};
if (!("removeEventListener" in g)) g.removeEventListener = () => {};

// Importa do build (dist/), não de src/index.ts diretamente: index.ts importa
// os irmãos com extensão `.js` (./buffer.js, ./route.js, ...), resolução que só
// existe depois do bundler (tsup) gerar dist/ — rodar contra src/ sem build
// prévio quebra com ERR_MODULE_NOT_FOUND (nada a ver com a correção do A05,
// mesmo comportamento de antes desta etapa). Rode `npm run build` antes de
// `npm test` sempre que src/ mudar.
const telemetria = await import("../dist/index.js");

// INTG-0139 A05 — cobre o achado A04: mark('action-ready') chamado antes de
// init() não pode se perder em silêncio, sem fila e sem erro (T3, "pronto pra
// agir", é o marco central do card).
//
// `sendBatch` (src/transport.ts) tenta `navigator.sendBeacon` e cai no
// fallback `fetch(..., { keepalive: true })` — nenhum dos dois existe em Node
// por padrão, então o teste injeta um `fetch` global fake pra capturar o
// payload que de fato saiu do buffer, sem precisar mockar módulo nem acessar
// campo privado do EventBuffer.

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

function marksFromCalls(calls: CapturedCall[]): string[] {
  return calls.flatMap((call) => {
    const payload = JSON.parse(call.body) as { marks: Array<{ name: string; timestamp: number }> };
    return payload.marks.map((mark) => mark.name);
  });
}

test("mark('action-ready') antes de init() não se perde — é drenado na ordem e chega ao envio", () => {
  telemetria.__resetForTest(); // state é singleton de módulo — isola do teste anterior
  withFakeFetch((calls) => {
    // mark() chamado ANTES de init() — cenário exato do achado A04.
    telemetria.mark("action-ready");

    telemetria.init({
      entitySlug: "teste-a05",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000, // não flusha sozinho por batch — só no flush() manual abaixo
    });

    // Sem a correção, T2/T3 nunca existiriam em lugar nenhum (nem no buffer,
    // nem no envio) porque mark() early-returnava com `state` ainda null.
    telemetria.flush();

    const names = marksFromCalls(calls);
    assert.ok(names.includes("T3"), "T3 (pronto pra agir) precisa ter sobrevivido ao pré-init");
    assert.ok(names.includes("T2"), "action-ready também grava T2 (contexto) no mesmo timestamp");
  });
});

test("mark() pré-init preserva a ordem de chegada e não perde marco arbitrário", () => {
  telemetria.__resetForTest();
  withFakeFetch((calls) => {
    telemetria.mark("action-ready"); // pré-init
    telemetria.mark("custom-antes-do-init"); // marco arbitrário, também pré-init

    telemetria.init({
      entitySlug: "teste-a05-ordem",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });

    telemetria.flush();

    const names = marksFromCalls(calls);
    assert.ok(names.includes("custom-antes-do-init"), "marco arbitrário chamado pré-init não pode ser perdido");

    // Ordem de chegada: os marcos enfileirados pré-init (T2, T3, custom-antes-do-init)
    // entram no buffer ANTES dos marcos que o próprio init() gera (T1, T4).
    const t3Index = names.indexOf("T3");
    const customIndex = names.indexOf("custom-antes-do-init");
    const t1Index = names.indexOf("T1");
    assert.ok(t3Index !== -1 && customIndex !== -1 && t1Index !== -1);
    assert.ok(t3Index < t1Index, "T3 (fila pré-init) precisa vir antes de T1 (gerado por init())");
    assert.ok(customIndex > t3Index, "ordem de chegada da fila é preservada (action-ready foi chamado antes)");
  });
});

test("mark() chamado sem nunca ter havido init() não lança", () => {
  telemetria.__resetForTest();
  assert.doesNotThrow(() => telemetria.mark("marco-solto-sem-init-algum-dia"));
});
