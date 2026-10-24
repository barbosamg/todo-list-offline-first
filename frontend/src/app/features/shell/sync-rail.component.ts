import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { SyncEngine } from '../../core/sync-engine';
import { IconComponent } from '../../ui/icon.component';

const MAX_TICKS = 24;

/**
 * Régua de sincronização — o estado da conexão como instrumento, sempre visível no topo.
 * A cor da faixa diz o estado (offline / sincronizando / sincronizado / falha) e cada
 * alteração ainda não confirmada pelo servidor é um "tique" na régua; quando o servidor confirma, os tiques somem.
 */
@Component({
  selector: 'app-sync-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { '[attr.data-state]': 'engine.state()' },
  template: `
    <div class="rail" role="status" aria-live="polite">
      <div class="state">
        @switch (engine.state()) {
          @case ('syncing') {
            <app-icon class="spin" name="refresh" [size]="16" [stroke]="2.4" />
          }
          @case ('offline') {
            <app-icon name="wifiOff" [size]="16" [stroke]="2.4" />
          }
          @case ('synced') {
            <span class="dot"></span>
          }
          @default {
            <app-icon name="alert" [size]="16" [stroke]="2.4" />
          }
        }
        <strong class="display">{{ headline() }}</strong>
        @if (engine.pending() > 0) {
          <span class="count mono">{{ engine.pending() }} pendente{{ engine.pending() === 1 ? '' : 's' }}</span>
        }
      </div>

      <div class="ticks" aria-hidden="true">
        @for (t of ticks(); track $index) {
          <i [style.animation-delay.ms]="$index * 45"></i>
        }
        @if (engine.pending() > ticks().length) {
          <span class="more mono">+{{ engine.pending() - ticks().length }}</span>
        }
      </div>

      <div class="right">
        @if (engine.lastSyncedAt(); as at) {
          <span class="last mono">Última sync {{ ago(at) }}</span>
        }
        @if (engine.state() === 'auth') {
          <button type="button" class="act" (click)="reauth()">Entrar novamente</button>
        } @else {
          <button type="button" class="act" (click)="engine.syncNow()" [disabled]="engine.state() === 'syncing'">
            <app-icon name="refresh" [size]="14" [stroke]="2.4" />
            <span>Sincronizar</span>
          </button>
        }
      </div>
    </div>
    <div class="edge" aria-hidden="true"></div>
  `,
  styleUrl: './sync-rail.component.scss',
})
export class SyncRailComponent {
  protected readonly engine = inject(SyncEngine);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  private readonly now = signal(Date.now());

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  protected readonly headline = computed(() => {
    switch (this.engine.state()) {
      case 'offline':
        return 'Offline';
      case 'syncing':
        return 'Sincronizando';
      case 'error':
        return 'Falha ao sincronizar';
      case 'auth':
        return 'Sessão expirada';
      default:
        return 'Sincronizado';
    }
  });

  protected readonly ticks = computed(() => Array.from({ length: Math.min(this.engine.pending(), MAX_TICKS) }));

  protected ago(at: number): string {
    const s = Math.max(0, Math.round((this.now() - at) / 1000));
    if (s < 45) return 'agora';
    const m = Math.round(s / 60);
    if (m < 60) return `há ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `há ${h} h`;
    return `há ${Math.round(h / 24)} d`;
  }

  protected reauth(): void {
    this.auth.logout(); // mantém os dados locais e a fila: só pede novo login
    void this.router.navigateByUrl('/login');
  }
}
