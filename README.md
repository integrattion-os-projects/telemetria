# @integrattion/telemetria

Telemetria leve de performance percebida para os sistemas do ecossistema
Integrattion. Mede o que o usuário sente — não só o que o servidor demora —
e envia em lote pro OS, sem nunca pesar no caminho crítico de renderização.

Parte do escopo **INTG-0139** ("Telas dos sistemas abrem rápido e em ordem").
Ver `~/_SixOS/six_agency_os/escopos/INTG-0139/ESCOPO-INTG-0139.md`, seção
"Especificação mínima — biblioteca de medição (A02)".

## Por que existe

Antes desta lib, nenhum sistema do ecossistema media o que o usuário
realmente sente ao abrir uma tela: só existiam medições de servidor
(TTFB, tempo de query) em auditorias manuais pontuais. Sem dado contínuo,
frequência de uso e "pronto pra agir" viravam chute.

## Orçamento de tamanho

O **núcleo** (tudo que roda antes de qualquer marco) é medido em
`dist/index.js` (build ESM) e tem que ficar **≤ 3 KB gzip**. Medido com
`npm run size` (gzip nível 9, `node:zlib`):

```
Núcleo (dist/index.js) gzip: 1792 bytes (1.75 KB) — OK
```

`web-vitals` **não entra nesse número**: é uma dependência declarada em
`package.json` (não devDependency), o núcleo só faz `import("web-vitals")`
dentro de `observeVitals()` (`src/vitals.ts`), então o bundler da app
resolve e carrega esse pacote como um chunk separado, sob demanda — nunca
estático no bundle do núcleo.

## Instalação

```bash
npm install @integrattion/telemetria
```

## Uso — 1 dependência + 1 linha no boot

A lib é framework-agnóstica: funciona igual em Next.js e em Vite. A única
regra dura é **nunca importar estaticamente** — sempre atrás de
`requestIdleCallback` depois do `load`, via import dinâmico.

### Autenticação — `endpoint` precisa incluir `?key=`

A chave de escrita vai na **query string** do `endpoint`, nunca em header
customizado — `navigator.sendBeacon` (o transporte principal da lib) não
permite headers customizados, só o corpo e a URL. Sem `?key=` na URL, todo
envio recebe `401 Unauthorized` da rota de ingestão.

```
https://os.integrattion.com.br/api/telemetria/ingest?key=<chave-da-entity>
```

Essa chave é **por entity** (não é a API key global do OS) e vem do campo
`Entity.telemetryWriteKey` no banco do Integrattion OS — cada sistema plugado
usa a própria chave, gerada uma vez pela entity correspondente. Os exemplos
abaixo já mostram o `endpoint` com o `?key=` incluído; copiar o exemplo sem
substituir `<chave-da-entity>` pela chave real também resulta em `401`.

### Next.js (app router)

```tsx
// app/telemetria-boot.tsx — client component, montado uma vez no layout raiz
"use client";
import { useEffect } from "react";

export function TelemetriaBoot() {
  useEffect(() => {
    const boot = () => {
      import("@integrattion/telemetria").then(({ init }) => {
        init({
          entitySlug: "integrattion-os",
          endpoint: "https://os.integrattion.com.br/api/telemetria/ingest?key=<chave-da-entity>",
          sampleRate: 0.1,
        });
      });
    };
    if (document.readyState === "complete") {
      requestIdleCallback(boot);
    } else {
      window.addEventListener("load", () => requestIdleCallback(boot), { once: true });
    }
  }, []);
  return null;
}
```

### Vite / SPA

```ts
// main.ts, depois do mount da app
function bootTelemetria() {
  import("@integrattion/telemetria").then(({ init }) => {
    init({
      entitySlug: "foccus",
      endpoint: "https://os.integrattion.com.br/api/telemetria/ingest?key=<chave-da-entity>",
      sampleRate: 0.1,
    });
  });
}

window.addEventListener("load", () => {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1));
  idle(bootTelemetria);
});
```

### Marcando "pronto pra agir" (T2/T3)

```ts
import { mark } from "@integrattion/telemetria";

// depois que os dados da tela chegaram e o usuário já pode agir sobre eles
mark("action-ready");
```

**`mark()` chamado antes de `init()` não se perde.** `init()` só roda depois
de `load` + `requestIdleCallback`, mas a app pode ficar "pronta pra agir"
antes disso (comum em SPA com hidratação rápida). Se `mark(...)` for chamado
nesse intervalo, o timestamp é capturado na hora e o marco é enfileirado
internamente; assim que `init()` roda, a fila é drenada na ordem em que os
marcos chegaram, antes dos marcos automáticos do próprio `init()` (T0/T1/T4).
Não é preciso nenhum código extra na app pra isso funcionar — é o
comportamento padrão de `mark()`.

## Navegação client-side (SPA) — desde 0.2.0

A lib percebe navegação DENTRO do app sozinha: assim que `init()` roda uma
vez, `pushState`/`replaceState`/`popstate` ficam instrumentados (App Router
do Next passa por `pushState`, mas a instrumentação é framework-agnóstica —
funciona em qualquer SPA). **Não é preciso chamar `init()` de novo a cada
troca de rota** — isso continua funcionando, mas é um reset completo (zera o
teto de eventos da sessão); pra troca de rota normal, deixe a lib perceber
sozinha.

A cada troca de rota, a lib fecha o ciclo da tela anterior (envia o que
estiver pendente com a rota certa) e abre um ciclo novo — T0/T1/T2/T3/T4 da
rota nova nunca herdam valor da rota anterior nem do boot original.
`sessionId` e o teto de eventos por sessão continuam os mesmos durante toda a
navegação: trocar de rota não é uma sessão nova, é a mesma sessão vendo
outra tela.

**Achado corrigido na 0.2.2:** em apps com SSR (App Router do Next), o
`pushState` só acontece DEPOIS do servidor responder (RSC) — usar esse
instante como referência (`routeStartTs`) deixava T1/T3/T4 cegos pra espera
de rede: com 3,6s reais de atraso no servidor, o T3 gravado continuava
~0,6s. Corrigido usando o CLIQUE como referência quando ele existe (sem teto
de tempo — cada clique é consumido por no máximo uma navegação), caindo de
volta pro `pushState` só quando não há clique rastreável (ex.: `popstate`
por atalho de teclado). T0 também deixou de "sumir" em navegações lentas: o
teto antigo de 3s (que fazia o clique "expirar") foi removido.

**Achado corrigido na 0.2.1:** a 0.2.0 corrigiu T0/T1/T4, mas `mark()`
(T2/T3) continuava gravando um instante absoluto desde o início do
DOCUMENTO — em produção simulada, o T3 de uma tela aberta por clique crescia
junto com o tempo que o usuário ficava parado na tela ANTERIOR, em vez de
refletir o tempo real da rota nova. Achado do verificador comparando o
tempo real clique→pronto contra o valor gravado, com permanências
diferentes na tela anterior. Corrigido com `routeStartTs`: todo marco
passa a ser relativo ao início do ciclo da rota atual, não ao início do
documento.

**Achado corrigido na 0.2.0 (INTG-0139 A09):** antes disso, `init()` fixava a
rota uma única vez no boot; toda tela aberta depois por clique (SPA) gravava
T1/T3/T4 com o tempo herdado da carga original, inflado — o card inteiro
dependia dessa correção pra medir o OS (que é SPA) e qualquer sistema
plugado que não seja boot direto a cada tela.

## Marcos medidos

| Marco | Significado | Como é obtido |
|---|---|---|
| T0 | Reação ao clique que motivou a navegação | Automático, só em navegação client-side: duração real do clique até o próximo quadro pintado (`requestAnimationFrame` duplo). **Não é emitido no boot inicial** — não existe um clique prévio que motivou o carregamento da primeira página. Só é emitido se um clique aconteceu nos últimos 3s antes da troca de rota (senão a navegação não veio de um clique rastreável, ex.: `popstate` por atalho de teclado). |
| T1 | Estrutura na tela | Boot inicial: `first-contentful-paint` (via `PerformanceObserver`/`getEntriesByType('paint')`). Navegação client-side: duração da troca de rota até o próximo quadro pintado (mesmo duplo `requestAnimationFrame` do T0). |
| T2 | Contexto carregado | Manual — `mark('context-ready')`, ou implícito junto com T3 se só `mark('action-ready')` for chamado (ver abaixo). Sempre da rota atual. |
| T3 | Pronto pra agir | Manual — `mark('action-ready')`. Sempre da rota atual — chamar em uma rota nunca aparece na rota anterior nem na seguinte. |
| T4 | Completo | Boot inicial: `loadEventEnd` da `PerformanceNavigationTiming`. Navegação client-side: duração da troca de rota até o navegador ficar ocioso (`requestIdleCallback`), como aproximação de "terminou de assentar" — SPA não tem um evento `load` por rota. |

**T2 e T3 pela mesma chamada.** Por decisão da spec A02, `mark('action-ready')`
grava T2 e T3 no mesmo timestamp — é o mínimo que uma app precisa chamar.
Quem quiser marcar o contexto separado (ex.: dados chegaram, mas a ação
principal só fica disponível depois de mais uma validação) chama
`mark('context-ready')` antes; isso grava um T2 mais cedo, e o
`action-ready` seguinte grava T3 normalmente (o T2 duplicado não quebra a
leitura de p50/p75/p95 no consolidado — dois pontos no mesmo marco).

Além dos T0–T4, LCP/INP/CLS/TTFB são capturados via `web-vitals` e viajam
junto no payload do lote (campo `vitals`), não como marks avulsos.

## Normalização de rota

`normalizeRoute(pathname, options?)` troca ids dinâmicos por `[id]` para
casar com o campo `route` de `SystemNode` no Integrattion OS.

```ts
normalizeRoute("/projetos/abc123/paginas/xyz");
// -> "/projetos/[id]/paginas/[id]"
```

**Heurística (decisão documentada):**
1. **Por conteúdo** — cobre a esmagadora maioria dos ids reais do
   ecossistema: numérico puro, UUID, ObjectId de 24 hex, `cuid` do Prisma,
   ou qualquer alfanumérico misto (letra + dígito) com 6+ caracteres.
2. **Fallback posicional** — um segmento curto (≤4 caracteres), só letras,
   que não está numa lista de palavras estáticas conhecidas
   (`STATIC_SEGMENT_WORDS`, exportada, mais o que for passado em
   `options.extraStaticSegments`) também vira `[id]`. Cobre ids opacos
   curtos sem dígito (como `xyz` no exemplo acima).

**Efeito colateral aceito:** uma rota estática nova de até 4 letras que não
esteja na stopword default (ex.: uma futura rota `/algo/nova`) viraria
`[id]` errado — nesse caso, passe `extraStaticSegments: ["nova"]` na config
da app. Ids reais do ecossistema (Prisma `cuid()`/`uuid()`, sempre com
dígito) nunca caem nesse fallback, então o caso comum está coberto sem
precisar de lista nenhuma.

## Buffer, lote e amostragem

- **Buffer em memória.** Nada é enviado por evento — só quando o lote fecha.
- **Dois gatilhos de flush**, nunca requisição por evento:
  (a) `document.visibilitychange` com `document.visibilityState === 'hidden'`;
  (b) a cada `batchSize` eventos acumulados (default 20, configurável).
- **Transporte:** `navigator.sendBeacon` (sobrevive à página fechando); cai
  pra `fetch(..., { keepalive: true })` só se `sendBeacon` não existir ou
  recusar o payload — ainda assim uma única requisição por lote.
- **Amostragem por sessão:** `sampleRate` (0..1, default 1) decide uma vez
  por `init()` se a sessão inteira participa ou não — nunca por evento.
- **Teto por sessão:** `maxEventsPerSession` (default 200) descarta em
  silêncio eventos além do teto, pra nunca floodar mesmo numa sessão
  anômala (loop de clique, bug de re-render).

## Configuração (`TelemetriaConfig`)

| Campo | Obrigatório | Default | Descrição |
|---|---|---|---|
| `entitySlug` | sim | — | Slug da entity no OS (bate com `SystemNode`). |
| `endpoint` | sim | — | URL completa de `POST /api/telemetria/ingest`. Nunca hardcoded pela lib. |
| `sampleRate` | não | `1` | Fração de sessões amostradas. |
| `batchSize` | não | `20` | Nº de eventos que dispara flush automático. |
| `maxEventsPerSession` | não | `200` | Teto de eventos aceitos na sessão. |
| `route` | não | `location.pathname` normalizado | Rota já normalizada, se a app preferir calcular a própria. |
| `extraStaticSegments` | não | — | Palavras estáticas extras para `normalizeRoute`. |
| `sessionId` | não | gerado localmente | Id de sessão, se a app já tiver um. |

## Contrato de payload — `POST /api/telemetria/ingest` (A03)

A rota de ingestão é implementada em paralelo no OS (etapa A03 do mesmo
card). Este é o contrato que a lib envia e que a rota deve aceitar:

```json
{
  "entitySlug": "integrattion-os",
  "route": "/projetos/[id]/paginas/[id]",
  "marks": [
    { "name": "T0", "timestamp": 12.4 },
    { "name": "T1", "timestamp": 340.1 },
    { "name": "T2", "timestamp": 812.0 },
    { "name": "T3", "timestamp": 812.0 },
    { "name": "T4", "timestamp": 1204.6 }
  ],
  "vitals": {
    "lcp": 1180.2,
    "inp": 96.0,
    "cls": 0.02,
    "ttfb": 210.5
  },
  "sessionId": "m1x2y3-ab12cd34"
}
```

- `marks[].timestamp` é `performance.now()` (ms relativos à navegação), não
  epoch — a rota de ingestão deve somar ao `navigationStart`/tempo de
  chegada do lote se precisar de timestamp absoluto.
- `vitals` pode vir parcialmente preenchido (alguns marcos chegam só depois
  do envio do primeiro lote, ex. LCP/CLS finais só fecham no
  `visibilitychange`) — a rota deve aceitar campos ausentes.
- Um mesmo `sessionId` pode gerar múltiplos POSTs (um por lote de
  `batchSize`, mais um final no `visibilitychange`) — a rota de ingestão
  não deve assumir "um POST = uma sessão inteira".

## API

```ts
import { init, mark, flush, normalizeRoute } from "@integrattion/telemetria";

init(config: TelemetriaConfig): void;
mark(name: string): void;
flush(): void; // força o envio do buffer pendente
normalizeRoute(pathname: string, options?: NormalizeRouteOptions): string;
```

## Desenvolvimento

```bash
npm install
npm run build   # tsup -> dist/ (esm + cjs + types) — rode antes de testar (test/index.test.ts importa de dist/)
npm test        # node --test, cobre normalização de rota, buffer/lote, teto, amostragem, mark() pré-init, navegação SPA
npm run size    # build + mede o gzip real do núcleo contra a meta de 3 KB
```

## Licença

MIT.
