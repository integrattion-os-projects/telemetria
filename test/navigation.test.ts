import { test } from "node:test";
import assert from "node:assert/strict";

// Shim mínimo de window/history/location pra simular navegação SPA em Node
// (sem DOM real). Cada teste chama `installFreshBrowserShim()` pra ganhar um
// `globalThis.window`/`history`/`location` NOVO — necessário porque
// `installNavigationHooks` (src/index.ts) só instala uma vez por objeto
// `history`, e `__resetForTest()` zera a flag exatamente pra permitir isso.
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

type Listener = () => void;

function installFreshBrowserShim(pathname: string): {
  fireRaf: () => void;
  fireIdle: () => void;
  firePopstate: () => void;
} {
  const listeners: Record<string, Listener[]> = { popstate: [] };
  const fakeWindow = {
    addEventListener: (type: string, cb: Listener) => {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener: () => {},
  };
  const fakeHistory: Record<string, unknown> = {
    pushState: () => {},
    replaceState: () => {},
  };
  const fakeLocation = { pathname };

  g.window = fakeWindow;
  g.history = fakeHistory;
  g.location = fakeLocation;
  g.addEventListener = fakeWindow.addEventListener;
  g.removeEventListener = () => {};

  let rafQueue: Array<() => void> = [];
  let idleQueue: Array<() => void> = [];
  g.requestAnimationFrame = (cb: () => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  g.requestIdleCallback = (cb: () => void) => {
    idleQueue.push(cb);
    return idleQueue.length;
  };

  return {
    fireRaf: () => {
      // doubleRaf agenda o 2º rAF só de dentro do 1º callback — drenar em
      // duas rodadas cobre isso sem a chamadora precisar saber da mecânica.
      const first = rafQueue;
      rafQueue = [];
      first.forEach((cb) => cb());
      const second = rafQueue;
      rafQueue = [];
      second.forEach((cb) => cb());
    },
    fireIdle: () => {
      const pending = idleQueue;
      idleQueue = [];
      pending.forEach((cb) => cb());
    },
    firePopstate: () => listeners.popstate.forEach((cb) => cb()),
  };
}

function setPathname(pathname: string): void {
  (g.location as { pathname: string }).pathname = pathname;
}

function pushState(): void {
  (g.history as { pushState: () => void }).pushState();
}

const telemetria = await import("../dist/index.js");

interface CapturedCall {
  url: string;
  body: string;
}

/**
 * Aceita `run` síncrono ou assíncrono. Se `run` devolver uma Promise, o
 * `fetch` fake só é restaurado depois dela resolver — sem isso, um teste
 * `async` que espera de verdade (ex.: simular permanência numa tela antes de
 * navegar) teria o `fetch` original restaurado cedo demais, no meio do await,
 * e o `flush()` chamado depois da espera perderia o fetch fake.
 */
function withFakeFetch<T>(run: (calls: CapturedCall[]) => T): T {
  const calls: CapturedCall[] = [];
  const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  const restore = () => {
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  };

  let result: T;
  try {
    result = run(calls);
  } catch (error) {
    restore();
    throw error;
  }

  if (result instanceof Promise) {
    return result.then(
      (value) => {
        restore();
        return value;
      },
      (error) => {
        restore();
        throw error;
      },
    ) as T;
  }

  restore();
  return result;
}

function payloadsFromCalls(
  calls: CapturedCall[],
): Array<{ route: string; marks: Array<{ name: string; timestamp: number }> }> {
  return calls.map((call) => JSON.parse(call.body));
}

// ---------------------------------------------------------------------------
// INTG-0139 A17 — troca de mecanismo. As versões 0.2.0-0.2.3 tentavam
// adivinhar "qual clique causou esta navegação" com uma heurística implícita
// (listener de clique global + flag de consumo). 4 rodadas de verificação
// seguidas (A10, A12, A14, A16) acharam um bug novo e distinto no mesmo
// mecanismo — o padrão mostrou que o problema era o DESENHO, não um bug
// pontual. Decisão do Fioda (30/09/2026): a lib não tenta mais adivinhar
// nada. Troca de rota (pushState/replaceState/popstate, comparando o
// pathname CRU) abre o ciclo novo sozinha, sempre, determinística — T1/T3/T4
// dependem só disso. `beginNavigation()` é opcional e afeta só o T0.
// ---------------------------------------------------------------------------

test("duas navegações seguidas (pushState) geram dois conjuntos de marcos, cada um com a rota certa", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a17",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush(); // fecha o ciclo do boot (/inicio) antes de navegar

    setPathname("/pagina-b");
    pushState();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.mark("action-ready");
    telemetria.flush();

    const payloads = payloadsFromCalls(calls);
    const rotaB = payloads.find((p) => p.route === "/pagina-b");
    assert.ok(rotaB, "precisa existir um payload com a rota nova (/pagina-b)");
    const nomes = rotaB!.marks.map((m) => m.name);
    assert.ok(nomes.includes("T1"), "rota nova grava T1 própria");
    assert.ok(nomes.includes("T3"), "rota nova grava T3 via mark('action-ready')");

    const rotaInicial = payloads.find((p) => p.route === "/inicio");
    assert.ok(rotaInicial, "o boot inicial precisa ter sido flushado com a própria rota");
    assert.ok(
      !rotaInicial!.marks.some((m) => m.name === "T3"),
      "T3 da rota nova não pode vazar pro payload da rota inicial",
    );
  });
});

test("T3 (mark) não cresce com o tempo parado na tela anterior — regressão do achado A10", async () => {
  // A10 encontrou T3 absoluto (nowMs() desde o início do documento): o valor
  // gravado crescia junto com a PERMANÊNCIA na tela anterior, em vez de
  // refletir o tempo real da rota nova. Continua valendo no novo mecanismo:
  // routeStartTs é sempre o instante do evento de navegação.
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  await withFakeFetch(async (calls) => {
    telemetria.init({
      entitySlug: "teste-a17-regressao-t3",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    // Permanência real na tela anterior — é justamente o que inflava o T3
    // antigo. 300ms é bem acima do teto que o teste checa abaixo (50ms).
    await new Promise((resolve) => setTimeout(resolve, 300));

    setPathname("/pagina-depois-de-espera");
    pushState();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.mark("action-ready"); // T3 da rota nova, gravado logo após navegar
    telemetria.flush();

    const rotaNova = payloadsFromCalls(calls).find((p) => p.route === "/pagina-depois-de-espera");
    assert.ok(rotaNova, "precisa existir payload da rota nova");
    const t3 = rotaNova!.marks.find((m) => m.name === "T3");
    assert.ok(t3, "T3 precisa existir");
    assert.ok(
      t3!.timestamp < 50,
      `T3 deveria ser pequeno (mark() chamado logo após navegar), mas veio ${t3!.timestamp}ms`,
    );
  });
});

test("navegação SEM beginNavigation() nunca inventa T0", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a17-sem-begin-nav",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    // Boot inicial: nunca teve T0 (não existe clique/intenção prévia).
    const bootPayload = payloadsFromCalls(calls).find((p) => p.route === "/inicio");
    assert.ok(!bootPayload?.marks.some((m) => m.name === "T0"), "boot inicial não emite T0");

    setPathname("/pagina-c");
    pushState(); // navegação sem beginNavigation() antes
    shim.fireRaf();
    shim.fireIdle();
    telemetria.flush();

    const rotaC = payloadsFromCalls(calls).find((p) => p.route === "/pagina-c");
    assert.ok(rotaC, "precisa existir payload da rota /pagina-c");
    assert.ok(
      !rotaC!.marks.some((m) => m.name === "T0"),
      "sem beginNavigation() antes, T0 nunca deve ser inventado",
    );
    assert.ok(rotaC!.marks.some((m) => m.name === "T1"), "T1 continua existindo, independente de T0");
  });
});

test("beginNavigation() antes da troca de rota grava T0 real (clique/intenção → próximo quadro pintado)", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a17-com-begin-nav",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    telemetria.beginNavigation(); // app chama no ponto exato onde decide navegar
    setPathname("/pagina-d");
    pushState();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.flush();

    const rotaD = payloadsFromCalls(calls).find((p) => p.route === "/pagina-d");
    assert.ok(rotaD, "precisa existir payload da rota /pagina-d");
    const t0 = rotaD!.marks.find((m) => m.name === "T0");
    assert.ok(t0, "T0 precisa existir quando beginNavigation() foi chamada antes da navegação");
    assert.ok(t0!.timestamp >= 0, "T0 é uma duração real (beginNavigation → paint)");
  });
});

test("beginNavigation() é consumida uma única vez — não vaza pra navegação seguinte", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a17-consumo-unico",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    telemetria.beginNavigation();
    setPathname("/pagina-e");
    pushState();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.flush();

    // Segunda navegação, SEM nova chamada a beginNavigation() — não deve
    // reaproveitar a intenção já consumida pela primeira.
    setPathname("/pagina-f");
    pushState();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.flush();

    const payloads = payloadsFromCalls(calls);
    const rotaE = payloads.find((p) => p.route === "/pagina-e");
    const rotaF = payloads.find((p) => p.route === "/pagina-f");
    assert.ok(rotaE?.marks.some((m) => m.name === "T0"), "primeira navegação consome a intenção e grava T0");
    assert.ok(
      !rotaF?.marks.some((m) => m.name === "T0"),
      "segunda navegação não deve reaproveitar a intenção já consumida pela primeira",
    );
  });
});

test("beginNavigation() sem troca de rota real não contamina a próxima navegação de verdade — regressão do achado R1 (A18)", async () => {
  // A18 encontrou: clicar num item de menu que aponta pra própria página
  // atual, com beginNavigation() antes, dispara um pushState/replaceState
  // que NÃO muda o pathname (early-return de handleRouteChange) — mas a
  // intenção pendente não era limpa nesse caminho, então sobrevivia e era
  // consumida pela PRÓXIMA navegação de verdade, minutos depois, inventando
  // um T0 sem relação nenhuma com ela.
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/bravo");

  await withFakeFetch(async (calls) => {
    telemetria.init({
      entitySlug: "teste-a19-r1",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    telemetria.beginNavigation(); // clique num item que aponta pra própria /bravo
    pushState(); // pathname não muda — early-return de handleRouteChange

    await new Promise((resolve) => setTimeout(resolve, 300)); // usuário lê a tela

    setPathname("/charlie"); // navegação de verdade, SEM beginNavigation() nova
    pushState();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.flush();

    const rotaCharlie = payloadsFromCalls(calls).find((p) => p.route === "/charlie");
    assert.ok(rotaCharlie, "precisa existir payload da rota /charlie");
    const t0 = rotaCharlie!.marks.find((m) => m.name === "T0");
    assert.ok(
      !t0,
      `T0 não deveria existir (a intenção antiga era de uma "navegação" que nem trocou de rota), mas veio ${t0?.timestamp}ms`,
    );
  });
});

test("popstate (botão voltar) dispara um ciclo novo de marcos, sem depender de beginNavigation()", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a17-popstate",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    setPathname("/pagina-g");
    shim.firePopstate();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.mark("action-ready");
    telemetria.flush();

    const rotaG = payloadsFromCalls(calls).find((p) => p.route === "/pagina-g");
    assert.ok(rotaG, "popstate precisa ter trocado a rota e gerado payload próprio");
    assert.ok(rotaG!.marks.some((m) => m.name === "T3"), "T3 da rota G via mark() depois do popstate");
    assert.ok(!rotaG!.marks.some((m) => m.name === "T0"), "sem beginNavigation(), popstate não inventa T0");
  });
});

test("telas do mesmo molde de rota abrem ciclo novo — regressão do achado F4 (A16)", () => {
  // A16 encontrou: comparar a rota NORMALIZADA pra decidir se houve troca
  // fazia duas telas do MESMO MOLDE (ex.: /card/1 -> /card/2, ambas
  // /card/[id]) nunca abrirem ciclo novo — existe de verdade no OS (card a
  // card, projeto a projeto). Corrigido comparando o pathname CRU.
  telemetria.__resetForTest();
  // "cards" (5 letras) em vez de "card" (4 letras) — normalizeRoute tem um
  // fallback posicional que vira `[id]` qualquer segmento de até 4 letras
  // só-letras fora da lista de palavras estáticas (ver route.ts); usar
  // "card" faria o PRÓPRIO segmento estático virar `[id]`, mascarando o
  // teste. "cards" fica de fora desse fallback e o molde vira /cards/[id].
  const shim = installFreshBrowserShim("/cards/1");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a17-f4-mesmo-molde",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    setPathname("/cards/2"); // mesmo molde normalizado, pathname CRU diferente
    pushState();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.mark("action-ready");
    telemetria.flush();

    const payloads = payloadsFromCalls(calls);
    const cardDois = payloads.find(
      (p) => p.route === "/cards/[id]" && p.marks.some((m) => m.name === "T3"),
    );
    assert.ok(
      cardDois,
      "card a card (mesmo molde de rota) precisa abrir ciclo novo — F4 exige comparar o pathname cru, não a rota normalizada",
    );

    // O T3 da segunda tela não pode ter vazado pro payload do card 1 (boot).
    const bootPayload = payloads.find(
      (p) => p.route === "/cards/[id]" && !p.marks.some((m) => m.name === "T3"),
    );
    assert.ok(bootPayload, "o boot (card 1) precisa ter sido flushado sem T3 nenhum");
  });
});

test("mudança só de parâmetro da URL (query string) não abre ciclo novo", () => {
  telemetria.__resetForTest();
  installFreshBrowserShim("/pagina");

  withFakeFetch(() => {
    telemetria.init({
      entitySlug: "teste-a17-query-string",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });

    // baseline inclui os marcos automáticos do boot (T1/T4), antes de
    // qualquer mark() manual — o teste confere um DELTA, não um total fixo.
    const aceitosNoBoot = telemetria.__getStateForTest()?.buffer.accepted ?? 0;

    const routeAntes = telemetria.__getStateForTest()?.config.route;
    telemetria.mark("evento-antes-da-query");

    // pathname não muda, só a query string mudaria na app real — o shim não
    // reflete isso em `location.search` porque a lib nem olha pra ele, só
    // pra `location.pathname` (que continua o mesmo aqui).
    pushState();

    const routeDepois = telemetria.__getStateForTest()?.config.route;
    assert.equal(routeAntes, routeDepois, "rota não muda quando o pathname é o mesmo");

    telemetria.mark("evento-depois-da-query");
    telemetria.flush();

    // Os dois eventos precisam ter ido pro MESMO ciclo (mesmo ponto de
    // referência), confirmando que não houve troca de ciclo no meio.
    const state = telemetria.__getStateForTest();
    assert.equal(
      state?.buffer.accepted,
      aceitosNoBoot + 2,
      "os dois marks ficam no mesmo buffer/ciclo — nenhuma troca de rota no meio",
    );
  });
});

test("mark('action-ready') chamado na rota B não contamina a rota A", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/rota-a");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a17-isolamento",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.mark("action-ready"); // T3 da rota A
    telemetria.flush();

    setPathname("/rota-b");
    pushState();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.mark("action-ready"); // T3 da rota B
    telemetria.flush();

    const payloads = payloadsFromCalls(calls);
    const rotaA = payloads.filter((p) => p.route === "/rota-a");
    const rotaB = payloads.find((p) => p.route === "/rota-b");

    const t3NaRotaA = rotaA.reduce(
      (acc, p) => acc + p.marks.filter((m) => m.name === "T3").length,
      0,
    );
    assert.equal(t3NaRotaA, 1, "rota A recebe exatamente o T3 que foi chamado nela, nunca o da rota B");
    assert.ok(rotaB?.marks.some((m) => m.name === "T3"), "rota B recebe o próprio T3");
  });
});

test("teto de eventos por sessão (spec A02) sobrevive à troca de rota — não reseta por navegação", () => {
  telemetria.__resetForTest();
  installFreshBrowserShim("/rota-a");

  withFakeFetch(() => {
    telemetria.init({
      entitySlug: "teste-a17-teto",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
      maxEventsPerSession: 3,
    });

    telemetria.mark("evento-1");
    telemetria.mark("evento-2");
    telemetria.mark("evento-3");
    telemetria.mark("evento-4-deveria-ser-descartado");

    setPathname("/rota-b");
    pushState();

    telemetria.mark("evento-5-tambem-deveria-ser-descartado");
    telemetria.flush();

    const state = telemetria.__getStateForTest();
    assert.equal(
      state?.buffer.accepted,
      3,
      "o teto de 3 eventos por SESSÃO continua valendo depois da troca de rota — não é recriado por navegação",
    );
  });
});
