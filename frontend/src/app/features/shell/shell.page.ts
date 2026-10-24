import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { NoticeService } from '../../core/notice.service';
import { TodoRepository } from '../../core/todo-repository';
import { IconComponent } from '../../ui/icon.component';
import { ComposerComponent } from '../tasks/composer.component';
import { FilterBarComponent } from '../tasks/filter-bar.component';
import { TaskEditorComponent } from '../tasks/task-editor.component';
import { TaskListState } from '../tasks/task-list-state';
import { TaskRowComponent } from '../tasks/task-row.component';
import { SidebarComponent } from './sidebar.component';
import { SyncRailComponent } from './sync-rail.component';

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SyncRailComponent, SidebarComponent, ComposerComponent, FilterBarComponent, TaskRowComponent, TaskEditorComponent, IconComponent],
  templateUrl: './shell.page.html',
  styleUrl: './shell.page.scss',
})
export class ShellPage {
  protected readonly state = inject(TaskListState);
  private readonly repo = inject(TodoRepository);
  protected readonly notices = inject(NoticeService);

  protected readonly pendingIds = this.repo.pendingIds;
  protected readonly menuOpen = signal(false);
  protected readonly editingId = signal<string | null>(null);
  private readonly composer = viewChild(ComposerComponent);

  protected readonly summary = computed(() => {
    const v = this.state.visible();
    const pending = v.filter((t) => t.status === 'pending').length;
    const urgent = v.filter((t) => t.isUrgent && t.status === 'pending').length;
    return { total: v.length, pending, urgent };
  });

  protected readonly hasAny = computed(() => this.state.totals().all > 0);

  protected toggle(id: string): void {
    void this.repo.toggle(id);
  }

  protected focusComposer(): void {
    this.composer()?.focus();
  }
}
