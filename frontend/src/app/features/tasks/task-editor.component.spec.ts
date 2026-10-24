import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoticeService } from '../../core/notice.service';
import { setupApp, tick } from '../../core/testing';
import { TodoRepository } from '../../core/todo-repository';
import { TaskEditorComponent } from './task-editor.component';

describe('TaskEditorComponent', () => {
  let fixture: ComponentFixture<TaskEditorComponent>;
  let repo: TodoRepository;
  let id: string;
  const q = <T extends HTMLElement>(sel: string) => fixture.nativeElement.querySelector(sel) as T;

  function set(sel: string, value: string) {
    const el = q<HTMLInputElement>(sel);
    el.value = value;
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  beforeEach(async () => {
    ({ repo } = await setupApp());
    id = await repo.create({ title: 'Inspecionar poste', description: 'lado norte', priority: 'low', category: 'Campo' });
    fixture = TestBed.createComponent(TaskEditorComponent);
    fixture.componentRef.setInput('todoId', id);
    fixture.detectChanges();
    await tick(5);
    fixture.detectChanges();
  });

  it('abre preenchido com os dados da tarefa', () => {
    expect(q<HTMLInputElement>('#ed-t').value).toBe('Inspecionar poste');
    expect(q<HTMLTextAreaElement>('#ed-d').value).toBe('lado norte');
    expect(q<HTMLInputElement>('#ed-cat').value).toBe('Campo');
    const pressed = fixture.nativeElement.querySelector('.prio button[aria-pressed="true"]') as HTMLElement;
    expect(pressed.textContent).toContain('Baixa');
  });

  it('salvar grava só o que mudou e fecha o painel', async () => {
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    set('#ed-t', 'Inspecionar poste 12');
    (fixture.nativeElement.querySelectorAll('.prio button')[2] as HTMLElement).click(); // Alta
    fixture.detectChanges();

    q<HTMLButtonElement>('button[type="submit"]').click();
    await tick();

    const t = repo.byId().get(id)!;
    expect([t.title, t.priority, t.description]).toEqual(['Inspecionar poste 12', 'high', 'lado norte']);
    expect(closed).toHaveBeenCalled();
  });

  it('título em branco desabilita o botão Salvar', () => {
    set('#ed-t', '   ');
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
  });

  it('digitar "urgente" mostra o aviso de que irá para o topo; apagar remove o aviso', () => {
    expect(fixture.nativeElement.querySelector('.hint')).toBeNull();
    set('#ed-d', 'é URGENTE');
    expect(fixture.nativeElement.querySelector('.hint')?.textContent).toContain('urgente');
    set('#ed-d', 'normal');
    expect(fixture.nativeElement.querySelector('.hint')).toBeNull();
  });

  it('salvar uma descrição com "urgente" torna a tarefa urgente e avisa', async () => {
    const notices = TestBed.inject(NoticeService);
    set('#ed-d', 'urgente!');
    q<HTMLButtonElement>('button[type="submit"]').click();
    await tick();
    expect(repo.byId().get(id)!.isUrgent).toBe(true);
    expect(notices.notices().some((n) => n.text.includes('fixada no topo'))).toBe(true);
  });

  it('marcar como concluída e definir vencimento', async () => {
    set('#ed-due', '2026-12-31');
    const check = q<HTMLInputElement>('.done input');
    check.click();
    fixture.detectChanges();
    q<HTMLButtonElement>('button[type="submit"]').click();
    await tick();

    const t = repo.byId().get(id)!;
    expect([t.dueDate, t.status]).toEqual(['2026-12-31', 'completed']);
  });

  it('cancelar fecha sem salvar', async () => {
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    set('#ed-t', 'Não deve gravar');
    (fixture.nativeElement.querySelectorAll('footer .btn')[1] as HTMLElement).click(); // Cancelar
    await tick();
    expect(closed).toHaveBeenCalled();
    expect(repo.byId().get(id)!.title).toBe('Inspecionar poste');
  });

  it('excluir pede confirmação; "Não" volta, "Sim" exclui', async () => {
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    (fixture.nativeElement.querySelector('footer .btn-danger') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ask')?.textContent).toContain('Excluir esta tarefa?');

    (fixture.nativeElement.querySelectorAll('footer .btn')[0] as HTMLElement).click(); // Não
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ask')).toBeNull();
    expect(repo.byId().get(id)).toBeDefined();

    (fixture.nativeElement.querySelector('footer .btn-danger') as HTMLElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('footer .btn-danger') as HTMLElement).click(); // Sim, excluir
    await tick();

    expect(repo.byId().get(id)).toBeUndefined();
    expect(closed).toHaveBeenCalled();
  });

  it('mostra o aviso de alterações aguardando envio enquanto houver pendência', () => {
    expect(fixture.nativeElement.querySelector('.unsynced')?.textContent).toContain('aguardando envio');
  });

  it('se a tarefa deixa de existir (apagada em outro dispositivo), o painel fecha sozinho', async () => {
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.componentRef.setInput('todoId', 'id-que-nao-existe');
    fixture.detectChanges();
    await tick();
    expect(closed).toHaveBeenCalled();
  });
});
