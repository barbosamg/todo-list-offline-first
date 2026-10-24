import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Todo } from '../../core/models';
import { IconComponent } from '../../ui/icon.component';
import { PriorityBarsComponent } from '../../ui/priority-bars.component';

@Component({
  selector: 'app-task-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, PriorityBarsComponent],
  host: {
    '[class.done]': "todo().status === 'completed'",
    '[class.urgent]': 'todo().isUrgent',
    '[class.selected]': 'selected()',
  },
  template: `
    <button
      type="button"
      class="check"
      [attr.aria-label]="todo().status === 'completed' ? 'Reabrir tarefa' : 'Concluir tarefa'"
      [attr.aria-pressed]="todo().status === 'completed'"
      (click)="toggle.emit(todo().id)"
    >
      <app-icon name="check" [size]="14" [stroke]="3.2" />
    </button>

    <button type="button" class="body" (click)="open.emit(todo().id)" [attr.aria-label]="'Editar: ' + todo().title">
      <span class="title">
        @if (todo().isUrgent) {
          <mark>{{ todo().title }}</mark>
        } @else {
          {{ todo().title }}
        }
      </span>
      @if (hasMeta()) {
        <span class="meta">
          @if (todo().isUrgent) {
            <span class="tag urgent-tag"><app-icon name="zap" [size]="12" [stroke]="2.6" />Urgente</span>
          }
          @if (todo().category) {
            <span class="tag"><app-icon name="hash" [size]="12" />{{ todo().category }}</span>
          }
          @if (todo().dueDate) {
            <span class="tag mono" [class.overdue]="overdue()">
              <app-icon name="calendar" [size]="12" />{{ dueLabel() }}
            </span>
          }
          @if (todo().description) {
            <span class="desc">{{ todo().description }}</span>
          }
        </span>
      }
    </button>

    <div class="end">
      @if (pending()) {
        <span class="unsynced" title="Alteração salva no aparelho, ainda não enviada" aria-label="Aguardando sincronização">
          <app-icon name="cloudUp" [size]="14" />
        </span>
      }
      <app-priority-bars [priority]="todo().priority" />
    </div>
  `,
  styleUrl: './task-row.component.scss',
})
export class TaskRowComponent {
  readonly todo = input.required<Todo>();
  readonly pending = input(false);
  readonly selected = input(false);
  readonly toggle = output<string>();
  readonly open = output<string>();

  protected readonly hasMeta = computed(() => {
    const t = this.todo();
    return t.isUrgent || !!t.category || !!t.dueDate || !!t.description;
  });

  protected readonly overdue = computed(() => {
    const t = this.todo();
    return !!t.dueDate && t.status === 'pending' && t.dueDate < today();
  });

  protected readonly dueLabel = computed(() => {
    const due = this.todo().dueDate!;
    const t = today();
    if (due === t) return 'Hoje';
    if (due === shift(t, 1)) return 'Amanhã';
    if (due === shift(t, -1)) return 'Ontem';
    const [y, m, d] = due.split('-');
    return `${d}/${m}${y === t.slice(0, 4) ? '' : '/' + y}`;
  });
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shift(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
