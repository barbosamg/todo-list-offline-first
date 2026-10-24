import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { PRIORITIES, PRIORITY_LABEL, Priority } from '../../core/models';
import { NoticeService } from '../../core/notice.service';
import { NO_CATEGORY } from '../../core/todo-query';
import { TodoRepository } from '../../core/todo-repository';
import { isUrgent } from '../../core/urgent-rule';
import { IconComponent } from '../../ui/icon.component';
import { PriorityBarsComponent } from '../../ui/priority-bars.component';
import { TaskListState } from './task-list-state';

/** Adição rápida: escreva e pressione Enter. Funciona sem conexão — a tarefa aparece na hora. */
@Component({
  selector: 'app-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, PriorityBarsComponent],
  template: `
    <form class="composer" (submit)="submit($event)">
      <app-icon name="plus" [size]="20" [stroke]="2.4" />
      <input
        #box
        class="text"
        type="text"
        name="title"
        autocomplete="off"
        maxlength="200"
        [value]="text()"
        (input)="text.set(box.value)"
        (keydown.enter)="submit($event, box.value)"
        placeholder="Nova tarefa…"
        aria-label="Título da nova tarefa"
        enterkeyhint="done"
      />
      <button
        type="button"
        class="prio"
        (click)="cyclePriority()"
        [attr.aria-label]="'Prioridade: ' + label() + '. Toque para alterar'"
        [attr.title]="'Prioridade ' + label().toLowerCase()"
      >
        <app-priority-bars [priority]="priority()" />
      </button>
      <button type="submit" class="btn btn-primary add" [disabled]="!text().trim()">Adicionar</button>
    </form>
  `,
  styles: `
    :host {
      display: block;
    }
    .composer {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 6px 6px 14px;
      background: var(--surface);
      border: 1.5px solid var(--line-strong);
      border-radius: var(--r-lg);
      box-shadow: var(--shadow-1);
      color: var(--ink-3);
      transition:
        border-color 0.12s,
        box-shadow 0.12s;
    }
    .composer:focus-within {
      border-color: var(--ink);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--focus) 16%, transparent);
      color: var(--ink);
    }
    .text {
      flex: 1;
      min-width: 0;
      height: 40px;
      border: 0;
      background: transparent;
      font-size: 16px;
      color: var(--ink);
    }
    .text:focus {
      outline: none;
    }
    .text::placeholder {
      color: var(--ink-3);
    }
    .prio {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border: 0;
      border-radius: var(--r-sm);
      background: transparent;
    }
    .prio:hover {
      background: var(--surface-2);
    }
    .add {
      min-height: 40px;
      border-radius: 13px;
    }
    @media (max-width: 720px) {
      .add {
        padding: 0 14px;
      }
    }
  `,
})
export class ComposerComponent {
  private readonly repo = inject(TodoRepository);
  private readonly state = inject(TaskListState);
  private readonly notices = inject(NoticeService);
  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  protected readonly text = signal('');
  protected readonly priority = signal<Priority>('medium');
  protected label = () => PRIORITY_LABEL[this.priority()];

  focus(): void {
    this.box().nativeElement.focus();
  }

  protected cyclePriority(): void {
    const next = PRIORITIES[(PRIORITIES.indexOf(this.priority()) + 1) % PRIORITIES.length];
    this.priority.set(next);
  }

  /** `typed` vem direto do campo: não depende do ciclo de renderização (Enter logo após digitar/colar). */
  protected async submit(e: Event, typed?: string): Promise<void> {
    e.preventDefault();
    if ((e as KeyboardEvent).isComposing) return; // Enter que confirma uma composição (IME) não envia
    const title = (typed ?? this.text()).trim();
    if (!title) return;
    const category = this.state.category();
    const priority = this.priority();

    // Limpa o campo ANTES de gravar: Enter repetido não duplica e o que for digitado depois não se perde.
    this.text.set('');
    this.box().nativeElement.value = '';
    this.priority.set('medium');

    try {
      await this.repo.create({ title, priority, ...(category && category !== NO_CATEGORY ? { category } : {}) });
    } catch {
      this.text.set(title);
      this.box().nativeElement.value = title;
      this.notices.push('error', 'Não foi possível salvar a tarefa neste aparelho.');
      return;
    }
    if (isUrgent(title, null)) this.notices.push('info', 'Contém “urgente”: a tarefa foi fixada no topo da lista.');
    this.focus();
  }
}
