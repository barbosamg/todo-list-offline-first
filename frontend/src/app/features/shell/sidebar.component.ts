import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { SyncEngine } from '../../core/sync-engine';
import { NO_CATEGORY } from '../../core/todo-query';
import { TodoRepository } from '../../core/todo-repository';
import { IconComponent } from '../../ui/icon.component';
import { TaskListState } from '../tasks/task-list-state';

@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { '[class.open]': 'open()' },
  template: `
    <div class="brand">
      <img src="favicon.svg" alt="" width="34" height="34" />
      <div>
        <strong class="display">Campo</strong>
        <small>tarefas que não dependem de sinal</small>
      </div>
    </div>

    <nav aria-label="Listas">
      <button type="button" class="item" [class.active]="state.category() === null" (click)="select(null)">
        <app-icon name="inbox" [size]="18" />
        <span class="name">Todas as tarefas</span>
        <span class="n mono">{{ state.totals().pending }}</span>
      </button>

      @if (state.lists().length) {
        <p class="group display">Listas</p>
      }
      @for (l of state.lists(); track l.name) {
        <button type="button" class="item" [class.active]="state.category() === l.name" (click)="select(l.name)">
          <app-icon name="hash" [size]="18" />
          <span class="name">{{ l.name }}</span>
          @if (l.urgent) {
            <span class="u mono" title="Urgentes pendentes">{{ l.urgent }}</span>
          }
          <span class="n mono">{{ l.pending }}</span>
        </button>
      }
      @if (state.lists().length && state.totals().uncategorized) {
        <button type="button" class="item" [class.active]="state.category() === noCategory" (click)="select(noCategory)">
          <app-icon name="list" [size]="18" />
          <span class="name">Sem lista</span>
          <span class="n mono">{{ state.totals().uncategorized }}</span>
        </button>
      }
      @if (!state.lists().length) {
        <p class="tip">Dê um nome de <strong>lista</strong> a uma tarefa para organizá-las por assunto.</p>
      }
    </nav>

    <div class="me">
      <div class="who">
        <app-icon name="user" [size]="18" />
        <div>
          <strong>{{ auth.user()?.name }}</strong>
          <small>{{ auth.user()?.email }}</small>
        </div>
      </div>
      <button type="button" class="btn btn-ghost btn-icon" (click)="logout()" aria-label="Sair" title="Sair">
        <app-icon name="logout" />
      </button>
    </div>
  `,
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  readonly open = input(false);
  readonly picked = output<void>();

  protected readonly state = inject(TaskListState);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly repo = inject(TodoRepository);
  private readonly engine = inject(SyncEngine);
  protected readonly noCategory = NO_CATEGORY;

  protected select(c: string | null): void {
    this.state.category.set(c);
    this.picked.emit();
  }

  protected logout(): void {
    const n = this.repo.pendingCount();
    if (n > 0 && !confirm(`Há ${n} alteraç${n === 1 ? 'ão' : 'ões'} ainda não enviada${n === 1 ? '' : 's'}. Elas ficam salvas neste aparelho e serão enviadas quando você entrar de novo. Sair mesmo assim?`)) return;
    this.engine.stop();
    this.auth.logout();
    void this.router.navigateByUrl('/login');
  }
}
