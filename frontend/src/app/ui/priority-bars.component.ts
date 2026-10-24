import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PRIORITY_LABEL, PRIORITY_RANK, Priority } from '../core/models';

/** Prioridade como "barras de sinal": 1 = baixa, 2 = média, 3 = alta (mesma linguagem da régua de sincronização). */
@Component({
  selector: 'app-priority-bars',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="bars" [class.high]="priority() === 'high'" role="img" [attr.aria-label]="'Prioridade ' + label()" [attr.title]="'Prioridade ' + label()">
      @for (i of [1, 2, 3]; track i) {
        <i [class.on]="i <= level()" [style.height.px]="4 + i * 4"></i>
      }
    </span>
  `,
  styles: `
    .bars {
      display: inline-flex;
      align-items: flex-end;
      gap: 2px;
      height: 16px;
    }
    i {
      width: 4px;
      border-radius: 1px;
      background: var(--bar-off, var(--line-strong));
    }
    i.on {
      background: var(--bar-on, var(--ink-2));
    }
    .high i.on {
      background: var(--bar-high, var(--urgent));
    }
  `,
})
export class PriorityBarsComponent {
  readonly priority = input.required<Priority>();
  protected readonly level = computed(() => PRIORITY_RANK[this.priority()] + 1);
  protected readonly label = computed(() => PRIORITY_LABEL[this.priority()].toLowerCase());
}
