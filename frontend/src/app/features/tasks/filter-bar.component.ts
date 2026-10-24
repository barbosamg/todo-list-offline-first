import { ChangeDetectionStrategy, Component, ElementRef, HostListener, inject, viewChild } from '@angular/core';
import { Priority, Status } from '../../core/models';
import { IconComponent } from '../../ui/icon.component';
import { TaskListState } from './task-list-state';

@Component({
  selector: 'app-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="search">
      <app-icon name="search" [size]="18" />
      <input
        #q
        class="input"
        type="search"
        autocomplete="off"
        placeholder="Buscar em título, descrição e lista  ( / )"
        aria-label="Buscar tarefas"
        [value]="state.query()"
        (input)="state.query.set(q.value)"
      />
    </div>

    <div class="chips">
      <div class="group" role="group" aria-label="Filtrar por status">
        @for (s of statuses; track s.value) {
          <button type="button" [attr.aria-pressed]="state.status() === s.value" (click)="state.status.set(s.value)">{{ s.label }}</button>
        }
      </div>

      <div class="group" role="group" aria-label="Filtrar por prioridade">
        @for (p of priorities; track p.value) {
          <button type="button" [attr.aria-pressed]="state.priority() === p.value" (click)="state.priority.set(p.value)">{{ p.label }}</button>
        }
      </div>

      @if (state.hasFilters()) {
        <button type="button" class="btn btn-ghost clear" (click)="state.clearFilters()">
          <app-icon name="x" [size]="16" />Limpar
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .search {
      position: relative;
      flex: 1 1 260px;
      color: var(--ink-3);
    }
    .search app-icon {
      position: absolute;
      left: 12px;
      top: 12px;
      pointer-events: none;
    }
    .search .input {
      padding-left: 38px;
    }
    .chips {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    @media (max-width: 720px) {
      /* celular: busca em linha própria; filtros numa única faixa rolável */
      .search {
        flex-basis: 100%;
      }
      .chips {
        width: 100%;
        overflow-x: auto;
        scrollbar-width: none;
        padding-bottom: 2px;
      }
      .chips::-webkit-scrollbar {
        display: none;
      }
      .group,
      .clear {
        flex: none;
      }
    }
    .group {
      display: inline-flex;
      padding: 3px;
      gap: 2px;
      border-radius: var(--r-md);
      background: var(--surface);
      border: 1px solid var(--line-strong);
    }
    .group button {
      min-height: 34px;
      padding: 0 12px;
      border: 0;
      border-radius: var(--r-sm);
      background: transparent;
      font-size: 13px;
      font-weight: 500;
      color: var(--ink-2);
    }
    .group button[aria-pressed='true'] {
      background: var(--brand);
      color: #fff;
    }
    .group button:not([aria-pressed='true']):hover {
      background: var(--surface-2);
    }
    .clear {
      min-height: 38px;
    }
  `,
})
export class FilterBarComponent {
  protected readonly state = inject(TaskListState);
  private readonly q = viewChild.required<ElementRef<HTMLInputElement>>('q');

  protected readonly statuses: { value: 'all' | Status; label: string }[] = [
    { value: 'all', label: 'Todas' },
    { value: 'pending', label: 'Pendentes' },
    { value: 'completed', label: 'Concluídas' },
  ];
  protected readonly priorities: { value: 'all' | Priority; label: string }[] = [
    { value: 'all', label: 'Qualquer' },
    { value: 'high', label: 'Alta' },
    { value: 'medium', label: 'Média' },
    { value: 'low', label: 'Baixa' },
  ];

  /** Atalho "/" foca a busca (fora de campos de texto). */
  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    const el = e.target as HTMLElement | null;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      this.q().nativeElement.focus();
    }
  }
}
