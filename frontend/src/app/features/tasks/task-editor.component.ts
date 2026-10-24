import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { PRIORITIES, PRIORITY_LABEL, Priority, Status } from '../../core/models';
import { NoticeService } from '../../core/notice.service';
import { TodoRepository } from '../../core/todo-repository';
import { isUrgent } from '../../core/urgent-rule';
import { IconComponent } from '../../ui/icon.component';
import { PriorityBarsComponent } from '../../ui/priority-bars.component';
import { TaskListState } from './task-list-state';

/** Painel de edição: lateral no desktop, "bottom sheet" no celular. Salva localmente na hora (offline-first). */
@Component({
  selector: 'app-task-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, PriorityBarsComponent],
  host: { '(document:keydown.escape)': 'close()' },
  template: `
    <div class="backdrop" (click)="close()"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="editor-title">
      <header>
        <h2 id="editor-title" class="display">Editar tarefa</h2>
        <button type="button" class="btn btn-ghost btn-icon" (click)="close()" aria-label="Fechar painel"><app-icon name="x" /></button>
      </header>

      <form (submit)="save($event)" (keydown.control.enter)="save($event)" (keydown.meta.enter)="save($event)">
        <div class="field">
          <label for="ed-t">Título</label>
          <input #first id="ed-t" class="input" maxlength="200" required [value]="title()" (input)="title.set(first.value)" />
        </div>

        <div class="field">
          <label for="ed-d">Descrição</label>
          <textarea #desc id="ed-d" class="input" maxlength="4000" [value]="description()" (input)="description.set(desc.value)"></textarea>
        </div>

        @if (willBeUrgent()) {
          <p class="hint">
            <app-icon name="alert" [size]="16" />
            <span>Contém “urgente” — fica fixada no topo da lista.</span>
          </p>
        }

        <div class="row2">
          <div class="field">
            <label for="ed-due">Vencimento</label>
            <input #due id="ed-due" class="input" type="date" [value]="dueDate()" (input)="dueDate.set(due.value)" />
          </div>
          <div class="field">
            <label for="ed-cat">Lista</label>
            <input #cat id="ed-cat" class="input" list="ed-lists" maxlength="50" placeholder="Ex.: Inspeção" [value]="category()" (input)="category.set(cat.value)" />
            <datalist id="ed-lists">
              @for (l of state.lists(); track l.name) {
                <option [value]="l.name"></option>
              }
            </datalist>
          </div>
        </div>

        <div class="field">
          <span class="label" id="ed-prio">Prioridade</span>
          <div class="seg prio" role="group" aria-labelledby="ed-prio">
            @for (p of priorities; track p) {
              <button type="button" [attr.aria-pressed]="priority() === p" (click)="priority.set(p)">
                <app-priority-bars [priority]="p" />{{ labels[p] }}
              </button>
            }
          </div>
        </div>

        <label class="done">
          <input type="checkbox" [checked]="status() === 'completed'" (change)="status.set(status() === 'completed' ? 'pending' : 'completed')" />
          <span>Tarefa concluída</span>
        </label>

        @if (isPending()) {
          <p class="unsynced">
            <app-icon name="cloudUp" [size]="16" />Há alterações salvas neste aparelho aguardando envio.
          </p>
        }

        <footer>
          @if (confirming()) {
            <span class="ask">Excluir esta tarefa?</span>
            <button type="button" class="btn btn-ghost" (click)="confirming.set(false)">Não</button>
            <button type="button" class="btn btn-danger" (click)="remove()">Sim, excluir</button>
          } @else {
            <button type="button" class="btn btn-danger" (click)="confirming.set(true)"><app-icon name="trash" [size]="16" />Excluir</button>
            <span class="grow"></span>
            <button type="button" class="btn" (click)="close()">Cancelar</button>
            <button type="submit" class="btn btn-primary" [disabled]="!title().trim()">Salvar</button>
          }
        </footer>
      </form>
    </section>
  `,
  styleUrl: './task-editor.component.scss',
})
export class TaskEditorComponent {
  readonly todoId = input.required<string>();
  readonly closed = output<void>();

  protected readonly state = inject(TaskListState);
  private readonly repo = inject(TodoRepository);
  private readonly notices = inject(NoticeService);
  private readonly first = viewChild<ElementRef<HTMLInputElement>>('first');

  protected readonly priorities = PRIORITIES;
  protected readonly labels = PRIORITY_LABEL;

  protected readonly title = signal('');
  protected readonly description = signal('');
  protected readonly dueDate = signal('');
  protected readonly category = signal('');
  protected readonly priority = signal<Priority>('medium');
  protected readonly status = signal<Status>('pending');
  protected readonly confirming = signal(false);

  protected readonly willBeUrgent = computed(() => isUrgent(this.title(), this.description()));
  protected readonly isPending = computed(() => this.repo.pendingIds().has(this.todoId()));

  constructor() {
    // carrega o formulário ao abrir (e não sobrescreve o que o usuário digita se o sync trouxer mudanças)
    effect(() => {
      const id = this.todoId();
      untracked(() => {
        const t = this.repo.byId().get(id);
        if (!t) return this.close();
        this.title.set(t.title);
        this.description.set(t.description ?? '');
        this.dueDate.set(t.dueDate ?? '');
        this.category.set(t.category ?? '');
        this.priority.set(t.priority);
        this.status.set(t.status);
        this.confirming.set(false);
        setTimeout(() => this.first()?.nativeElement.focus());
      });
    });
  }

  protected close(): void {
    this.closed.emit();
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.title().trim()) return;
    const before = this.repo.byId().get(this.todoId());
    await this.repo.update(this.todoId(), {
      title: this.title(),
      description: this.description(),
      dueDate: this.dueDate() || null,
      category: this.category(),
      priority: this.priority(),
      status: this.status(),
    });
    if (this.willBeUrgent() && !before?.isUrgent) this.notices.push('info', 'Contém “urgente”: a tarefa foi fixada no topo da lista.');
    this.close();
  }

  protected async remove(): Promise<void> {
    await this.repo.remove(this.todoId());
    this.notices.push('success', 'Tarefa excluída.');
    this.close();
  }
}
