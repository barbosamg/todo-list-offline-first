import { Injectable, signal } from '@angular/core';

export type NoticeKind = 'info' | 'success' | 'warn' | 'error';
export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
}

/** Avisos efêmeros (toasts) — conflitos resolvidos, operações recusadas, urgentes etc. */
@Injectable({ providedIn: 'root' })
export class NoticeService {
  readonly notices = signal<readonly Notice[]>([]);
  private next = 1;

  push(kind: NoticeKind, text: string, ttlMs = 5000): void {
    const id = this.next++;
    this.notices.update((list) => [...list.slice(-3), { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ttlMs);
  }

  dismiss(id: number): void {
    this.notices.update((list) => list.filter((n) => n.id !== id));
  }
}
