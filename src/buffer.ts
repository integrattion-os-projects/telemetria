/**
 * Buffer em memória com teto de eventos por sessão e disparo de flush em
 * lote — nunca uma requisição de rede por evento (spec A02).
 */

export interface BufferedEvent {
  name: string;
  timestamp: number;
}

export interface EventBufferOptions {
  /** Nº de eventos acumulados que dispara flush automático. Default 20. */
  batchSize?: number;
  /** Teto de eventos aceitos na sessão inteira, mesmo com flushes no meio. Default 200. */
  maxEventsPerSession?: number;
  onFlush: (events: BufferedEvent[]) => void;
}

export class EventBuffer {
  private events: BufferedEvent[] = [];
  private totalAccepted = 0;
  private readonly batchSize: number;
  private readonly maxEventsPerSession: number;
  private readonly onFlush: (events: BufferedEvent[]) => void;

  constructor(options: EventBufferOptions) {
    this.batchSize = options.batchSize ?? 20;
    this.maxEventsPerSession = options.maxEventsPerSession ?? 200;
    this.onFlush = options.onFlush;
  }

  /** Quantos eventos essa sessão já aceitou (incluindo os já drenados). */
  get accepted(): number {
    return this.totalAccepted;
  }

  /** Quantos eventos estão no buffer aguardando flush. */
  get pending(): number {
    return this.events.length;
  }

  get isAtCap(): boolean {
    return this.totalAccepted >= this.maxEventsPerSession;
  }

  /** Adiciona um evento. Descartado em silêncio se o teto da sessão já bateu. */
  push(event: BufferedEvent): void {
    if (this.isAtCap) return;
    this.events.push(event);
    this.totalAccepted += 1;
    if (this.events.length >= this.batchSize) {
      this.flush();
    }
  }

  /** Esvazia o buffer e chama onFlush com o lote, se houver algo pendente. */
  flush(): void {
    if (this.events.length === 0) return;
    const batch = this.events;
    this.events = [];
    this.onFlush(batch);
  }
}
