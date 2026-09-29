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
  fireClick: () => void;
  fireRaf: () => void;
  fireIdle: () => void;
  firePopstate: () => void;
} {
  const listeners: Record<string, Listener[]> = { click: [], popstate: [] };
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
    fireClick: () => listeners.click.forEach((cb) => cb()),
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

function payloadsFromCalls(calls: CapturedCall[]): Array<{ route: string; marks: Array<{ name: string; timestamp: number }> }> {
  return calls.map((call) => JSON.parse(call.body));
}

test("duas navegações seguidas (pushState) geram dois conjuntos de marcos, cada um com a rota certa", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a09",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush(); // fecha o ciclo do boot (/inicio) antes de navegar

    setPathname("/pagina-b");
    (g.history as { pushState: () => void }).pushState();
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
  // A10 encontrou T3 absoluto (nowMs() desde o início do documento) mesmo
  // depois do A09 corrigir T0/T1/T4: o valor gravado crescia junto com a
  // PERMANÊNCIA na tela anterior, em vez de refletir o tempo real da rota
  // nova. O teste antigo só conferia `nomes.includes("T3")`, nunca o valor —
  // por isso não pegou. Este replica o cenário: espera de verdade ANTES de
  // navegar, e confirma que o T3 da rota nova continua pequeno.
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  await withFakeFetch(async (calls) => {
    telemetria.init({
      entitySlug: "teste-a11-regressao-t3",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    // Permanência real na tela anterior — é justamente o que inflava o T3
    // antigo. 300ms é bem acima do teto que o teste checa abaixo (50ms).
    await new Promise((resolve) => setTimeout(resolve, 300));

    setPathname("/pagina-depois-de-espera");
    (g.history as { pushState: () => void }).pushState();
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
      `T3 deveria ser pequeno (mark() chamado logo após navegar), mas veio ${t3!.timestamp}ms — ` +
        `sinal de que herdou os 300ms de permanência na tela anterior (regressão do achado A10)`,
    );
  });
});

test("T3 inclui a espera de rede entre o clique e o pushState (SSR/App Router) — regressão do achado A12", async () => {
  // A12 encontrou que routeStartTs usava o instante do pushState — em apps
  // com SSR (App Router do Next), pushState só acontece DEPOIS do servidor
  // responder, então T1/T3/T4 não incluíam a espera de rede: com 3,6s reais
  // de atraso no servidor, o T3 gravado continuava ~0,6s (o clique já tinha
  // acontecido havia tempo). Este teste simula exatamente essa topologia:
  // clique -> espera real (proxy da ida ao servidor) -> só ENTÃO pushState.
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  await withFakeFetch(async (calls) => {
    telemetria.init({
      entitySlug: "teste-a13-regressao-rsc",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    shim.fireClick(); // usuário clica — o "servidor" começa a responder agora
    await new Promise((resolve) => setTimeout(resolve, 200)); // proxy da espera de RSC
    setPathname("/pagina-lenta");
    (g.history as { pushState: () => void }).pushState(); // só agora o router troca a rota
    shim.fireRaf();
    shim.fireIdle();
    telemetria.mark("action-ready");
    telemetria.flush();

    const rotaLenta = payloadsFromCalls(calls).find((p) => p.route === "/pagina-lenta");
    assert.ok(rotaLenta, "precisa existir payload da rota lenta");
    const t3 = rotaLenta!.marks.find((m) => m.name === "T3");
    const t0 = rotaLenta!.marks.find((m) => m.name === "T0");
    assert.ok(t3, "T3 precisa existir");
    assert.ok(t0, "T0 precisa existir (havia um clique rastreável antes do pushState)");
    assert.ok(
      t3!.timestamp >= 200,
      `T3 deveria incluir os ~200ms de espera entre o clique e o pushState, mas veio ${t3!.timestamp}ms — ` +
        `sinal de que a referência ainda é o pushState, não o clique (regressão do achado A12)`,
    );
  });
});

test("clique que não navega não contamina uma navegação não relacionada depois (popstate) — regressão do achado A14", async () => {
  // A14 encontrou: um clique que NÃO leva a navegação nenhuma (ex.: clicar
  // num <h1>) ficava pendente sem teto, e era consumido pela PRÓXIMA
  // navegação de qualquer tipo — inclusive popstate do botão voltar, minutos
  // depois, sem relação nenhuma com aquele clique. Reintroduzia o defeito do
  // A10 por outro caminho, e ainda inventava um T0 que nunca aconteceu.
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  await withFakeFetch(async (calls) => {
    telemetria.init({
      entitySlug: "teste-a15-clique-orfao",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    shim.fireClick(); // clique que NÃO leva a pushState/replaceState nenhum
    await new Promise((resolve) => setTimeout(resolve, 300)); // usuário lê a tela

    setPathname("/pagina-depois-de-voltar");
    shim.firePopstate(); // botão voltar — não tem relação com o clique acima
    shim.fireRaf();
    shim.fireIdle();
    telemetria.mark("action-ready");
    telemetria.flush();

    const rotaNova = payloadsFromCalls(calls).find((p) => p.route === "/pagina-depois-de-voltar");
    assert.ok(rotaNova, "precisa existir payload da rota nova");

    const t0 = rotaNova!.marks.find((m) => m.name === "T0");
    assert.ok(!t0, `T0 não deveria existir (popstate não tem clique associado), mas veio ${t0?.timestamp}ms`);

    const t3 = rotaNova!.marks.find((m) => m.name === "T3");
    assert.ok(t3, "T3 precisa existir");
    assert.ok(
      t3!.timestamp < 50,
      `T3 deveria ser pequeno (mark() chamado logo após o popstate), mas veio ${t3!.timestamp}ms — ` +
        `sinal de que o clique órfão contaminou esta navegação (regressão do achado A14)`,
    );
  });
});

test("T0 da navegação é medido do clique ao próximo quadro pintado, não herdado da carga inicial", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a09-t0",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    // Sem T0 no boot inicial (achado do C01: não existe clique prévio que
    // motivou o carregamento original).
    const bootPayload = payloadsFromCalls(calls).find((p) => p.route === "/inicio");
    assert.ok(!bootPayload?.marks.some((m) => m.name === "T0"), "boot inicial não emite T0");

    shim.fireClick(); // usuário clica num link — dispara a navegação
    setPathname("/pagina-c");
    (g.history as { pushState: () => void }).pushState();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.flush();

    const rotaC = payloadsFromCalls(calls).find((p) => p.route === "/pagina-c");
    assert.ok(rotaC, "precisa existir payload da rota /pagina-c");
    const t0 = rotaC!.marks.find((m) => m.name === "T0");
    assert.ok(t0, "T0 precisa existir quando há clique recente antes da navegação");
    assert.ok(t0!.timestamp >= 0, "T0 é uma duração real (clique → paint), não um instante absoluto herdado");
  });
});

test("popstate (botão voltar) também dispara um ciclo novo de marcos", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/inicio");
  let popstateHandler: (() => void) | undefined;

  withFakeFetch((calls) => {
    // Intercepta o registro de popstate manualmente pra poder disparar.
    const originalAdd = (g.window as { addEventListener: (t: string, cb: () => void) => void })
      .addEventListener;
    (g.window as { addEventListener: (t: string, cb: () => void) => void }).addEventListener = (
      type,
      cb,
    ) => {
      if (type === "popstate") popstateHandler = cb;
      originalAdd(type, cb);
    };

    telemetria.init({
      entitySlug: "teste-a09-popstate",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.flush();

    setPathname("/pagina-d");
    assert.ok(popstateHandler, "popstate precisa ter sido registrado por installNavigationHooks");
    popstateHandler!();
    shim.fireRaf();
    shim.fireIdle();
    telemetria.mark("action-ready");
    telemetria.flush();

    const rotaD = payloadsFromCalls(calls).find((p) => p.route === "/pagina-d");
    assert.ok(rotaD, "popstate precisa ter trocado a rota e gerado payload próprio");
    assert.ok(rotaD!.marks.some((m) => m.name === "T3"), "T3 da rota D via mark() depois do popstate");
  });
});

test("mark('action-ready') chamado na rota B não contamina a rota A", () => {
  telemetria.__resetForTest();
  const shim = installFreshBrowserShim("/rota-a");

  withFakeFetch((calls) => {
    telemetria.init({
      entitySlug: "teste-a09-isolamento",
      endpoint: "http://localhost/telemetria-teste",
      sampleRate: 1,
      batchSize: 1000,
    });
    telemetria.mark("action-ready"); // T3 da rota A
    telemetria.flush();

    setPathname("/rota-b");
    (g.history as { pushState: () => void }).pushState();
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
      entitySlug: "teste-a09-teto",
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
    (g.history as { pushState: () => void }).pushState();

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
