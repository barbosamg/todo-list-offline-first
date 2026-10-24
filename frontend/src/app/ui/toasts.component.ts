import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NoticeService } from '../core/notice.service';
import { IconComponent } from './icon.component';

@Component({
  selector: 'app-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="stack" role="region" aria-label="Avisos" aria-live="polite">
      @for (n of notices.notices(); track n.id) {
        <div class="toast" [class]="n.kind" role="status">
          <app-icon [name]="n.kind === 'success' ? 'check' : n.kind === 'info' ? 'zap' : 'alert'" [size]="18" />
          <span>{{ n.text }}</span>
          <button type="button" class="x" (click)="notices.dismiss(n.id)" aria-label="Dispensar aviso">
            <app-icon name="x" [size]="16" />
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    .stack {
      position: fixed;
      z-index: 60;
      left: 16px;
      bottom: calc(16px + var(--safe-bottom));
      display: grid;
      gap: 8px;
      width: min(380px, calc(100vw - 32px));
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: start;
      padding: 12px 12px 12px 14px;
      border-radius: var(--r-md);
      background: var(--ink);
      color: #fff;
      box-shadow: var(--shadow-2);
      font-size: 14px;
      animation: in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    }
    .toast.warn {
      background: var(--warn);
      color: var(--warn-ink);
    }
    .toast.error {
      background: var(--bad);
    }
    .toast.success app-icon {
      color: var(--marker);
    }
    .x {
      border: 0;
      background: transparent;
      color: inherit;
      opacity: 0.7;
      padding: 2px;
      line-height: 0;
    }
    .x:hover {
      opacity: 1;
    }
    @keyframes in {
      from {
        transform: translateY(12px);
        opacity: 0;
      }
    }
  `,
})
export class ToastsComponent {
  protected readonly notices = inject(NoticeService);
}
