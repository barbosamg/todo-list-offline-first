import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { OutboxOp, SyncResponse, WireMutation } from './models';
import { NoticeService } from './notice.service';
import { TodoRepository } from './todo-repository';

export type SyncState = 'offline' | 'syncing' | 'synced' | 'error' | 'auth';

const BATCH = 200;
const POLL_MS = 20_000;
const FIELD_LABEL: Record<string, string> = {
  title: 'título',
  description: 'descrição',
  dueDate: 'vencimento',
  priority: 'prioridade',
  status: 'status',
  category: 'lista',
};

/**
 * Sincronização automática (push da fila + pull do que mudou, em uma ida e volta).
 * Dispara: ao abrir, ao voltar a conexão, após cada escrita local, ao voltar para a aba e
 * periodicamente. Falhas de rede/servidor agendam nova tentativa com backoff exponencial;
 * a fila offline só é esvaziada quando o servidor confirma.
 */
@Injectable({ providedIn: 'root' })
export class SyncEngine {
  private readonly http = inject(HttpClient);
  private readonly repo = inject(TodoRepository);
  private readonly auth = inject(AuthService);
  private readonly notices = inject(NoticeService);

  readonly state = signal<SyncState>(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'synced');
  readonly pending = this.repo.pendingCount;
  readonly lastSyncedAt = this.repo.lastSyncedAt;
  /** O que a interface mostra (já considera a fila): ex. "Offline · 3 pendentes". */
  readonly label = computed(() => {
    const n = this.pending();
    const pend = n === 1 ? '1 alteração pendente' : `${n} alterações pendentes`;
    switch (this.state()) {
      case 'offline':
        return n ? `Offline · ${pend}` : 'Offline';
      case 'syncing':
        return n ? `Sincronizando · ${pend}` : 'Sincronizando';
      case 'error':
        return n ? `Falha ao sincronizar · ${pend}` : 'Falha ao sincronizar';
      case 'auth':
        return n ? `Sessão expirada · ${pend}` : 'Sessão expirada';
      default:
        return 'Sincronizado';
    }
  });

  constructor() {
    // Toda escrita local agenda um envio (agrupando rajadas); sem rede, o envio simplesmente fica na fila.
    effect(() => {
      if (this.repo.writes() > 0) untracked(() => this.kick());
    });
  }

  private running = false;
  private again = false;
  private started = false;
  private failures = 0;
  private kickTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  start(): void {
    if (this.started) return;
    this.started = true;
    addEventListener('online', this.onOnline);
    addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.run(true);
    }, POLL_MS);
    void this.run();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    removeEventListener('online', this.onOnline);
    removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearInterval(this.pollTimer);
    clearTimeout(this.kickTimer);
    clearTimeout(this.retryTimer);
  }

  /** Chamado após cada escrita local: junta rajadas de edições num único envio. */
  kick(delayMs = 300): void {
    clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => void this.run(), delayMs);
  }

  /** Sincronização manual / imediata. */
  syncNow(): Promise<void> {
    this.failures = 0;
    return this.run();
  }

  private readonly onOnline = () => {
    this.failures = 0;
    void this.run();
  };
  private readonly onOffline = () => this.state.set('offline');
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') void this.run(true);
  };

  async run(silent = false): Promise<void> {
    if (!this.repo.ready()) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        clearTimeout(this.retryTimer);
        if (!navigator.onLine) {
          this.state.set('offline');
          break;
        }
        if (this.auth.expired()) {
          this.state.set('auth');
          break;
        }
        if (!silent || this.repo.pendingCount() > 0) this.state.set('syncing');
        const outcome = await this.drain();
        if (outcome === 'ok') {
          this.failures = 0;
          this.state.set('synced');
        } else {
          this.state.set(outcome);
          if (outcome !== 'auth') this.scheduleRetry();
        }
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  /** Repete push+pull até a fila esvaziar e não haver mais páginas para baixar. */
  private async drain(): Promise<'ok' | 'offline' | 'error' | 'auth'> {
    for (;;) {
      const batch = this.repo.takeBatch(BATCH);
      try {
        const res = await firstValueFrom(
          this.http.post<SyncResponse>('/api/sync', { cursor: this.repo.cursor, mutations: batch.map(toWire) }),
        );
        await this.repo.commit(batch, res);
        this.report(res);
        const confirmed = res.results.length;
        if (batch.length > 0 && confirmed === 0) return 'error'; // protege contra laço sem progresso
        if (!res.hasMore && this.repo.pendingCount() === 0) return 'ok';
      } catch (e) {
        this.repo.releaseBatch();
        return classify(e);
      }
    }
  }

  private scheduleRetry(): void {
    this.failures++;
    const delay = Math.min(5_000 * 2 ** (this.failures - 1), 60_000);
    this.retryTimer = setTimeout(() => void this.run(), delay);
  }

  private report(res: SyncResponse): void {
    for (const r of res.results) {
      if (r.status === 'rejected') {
        this.notices.push('error', `Uma alteração foi recusada pelo servidor: ${r.error ?? 'dados inválidos'}`, 8000);
      } else if (r.rejectedFields?.length) {
        const fields = r.rejectedFields.map((f) => FIELD_LABEL[f] ?? f).join(', ');
        this.notices.push('warn', `Conflito resolvido: sua edição de ${fields} foi substituída por uma mais recente feita em outro lugar.`, 8000);
      }
    }
  }
}

function toWire(op: OutboxOp): WireMutation {
  return { opId: op.opId, id: op.id, changes: op.changes, deletedAt: op.deletedAt, createdAt: op.createdAt };
}

function classify(e: unknown): 'offline' | 'error' | 'auth' {
  if (e instanceof HttpErrorResponse) {
    // sem rota até o servidor: offline real, "lie-fi" ou proxy/gateway sem backend (502/503/504)
    if (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504) return 'offline';
    if (e.status === 401) return 'auth';
  }
  return 'error';
}
