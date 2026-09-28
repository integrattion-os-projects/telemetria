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
Núcleo (dist/index.js) gzip: 1691 bytes (1.65 KB) — OK
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
          endpoint: "https://os.integrattion.com.br/api/telemetria/ingest",
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
      endpoint: "https://os.integrattion.com.br/api/telemetria/ingest",
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

## Marcos medidos

| Marco | Significado | Como é obtido |
|---|---|---|
| T0 | Reação ao clique/navegação | Automático: timestamp do primeiro `click` capturado após `init()`. |
| T1 | Estrutura na tela | Automático: `first-contentful-paint` (via `PerformanceObserver`/`getEntriesByType('paint')`), ou o instante do `init()` se a API não existir. |
| T2 | Contexto carregado | Manual — `mark('context-ready')`, ou implícito junto com T3 se só `mark('action-ready')` for chamado (ver abaixo). |
| T3 | Pronto pra agir | Manual — `mark('action-ready')`. |
| T4 | Completo | Automático: `loadEventEnd` da `PerformanceNavigationTiming`, ou o instante do `init()` se a API não existir. |

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
npm test        # node --test, cobre normalização de rota, buffer/lote, teto, amostragem
npm run build   # tsup -> dist/ (esm + cjs + types)
npm run size    # build + mede o gzip real do núcleo contra a meta de 3 KB
```

## Licença

MIT.
