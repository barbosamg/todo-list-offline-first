import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankTodo } from '../../core/merge';
import { Todo } from '../../core/models';
import { TaskRowComponent } from './task-row.component';

const iso = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('TaskRowComponent', () => {
  let fixture: ComponentFixture<TaskRowComponent>;
  const el = () => fixture.nativeElement as HTMLElement;

  function render(todo: Partial<Todo>, inputs: { pending?: boolean; selected?: boolean } = {}) {
    fixture.componentRef.setInput('todo', { ...blankTodo('t1', 1), title: 'Inspecionar poste', ...todo });
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    fixture = TestBed.createComponent(TaskRowComponent);
  });

  it('mostra o título e a prioridade acessível', () => {
    render({ priority: 'high' });
    expect(el().querySelector('.title')?.textContent).toContain('Inspecionar poste');
    expect(el().querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Prioridade alta');
  });

  it('tarefa urgente ganha a classe, a etiqueta e nenhuma marcação no texto', () => {
    render({ isUrgent: true });
    expect(el().classList.contains('urgent')).toBe(true);
    expect(el().querySelector('.urgent-tag')?.textContent).toContain('Urgente');
  });

  it('tarefa comum não tem etiqueta de urgência', () => {
    render({ isUrgent: false });
    expect(el().querySelector('.urgent-tag')).toBeNull();
    expect(el().classList.contains('urgent')).toBe(false);
  });

  it('concluída: classe "done" e checkbox marcado com rótulo para reabrir', () => {
    render({ status: 'completed' });
    expect(el().classList.contains('done')).toBe(true);
    const check = el().querySelector('.check')!;
    expect(check.getAttribute('aria-pressed')).toBe('true');
    expect(check.getAttribute('aria-label')).toBe('Reabrir tarefa');
  });

  it('pendente: rótulo "Concluir tarefa"', () => {
    render({ status: 'pending' });
    expect(el().querySelector('.check')?.getAttribute('aria-label')).toBe('Concluir tarefa');
  });

  it('clicar no checkbox emite toggle com o id; clicar no corpo emite open', () => {
    render({ id: 'abc' });
    const toggle = vi.fn();
    const open = vi.fn();
    fixture.componentInstance.toggle.subscribe(toggle);
    fixture.componentInstance.open.subscribe(open);

    (el().querySelector('.check') as HTMLElement).click();
    (el().querySelector('.body') as HTMLElement).click();

    expect(toggle).toHaveBeenCalledWith('abc');
    expect(open).toHaveBeenCalledWith('abc');
  });

  it('ícone de "aguardando sincronização" só aparece com alteração pendente', () => {
    render({}, { pending: false });
    expect(el().querySelector('.unsynced')).toBeNull();

    fixture.componentRef.setInput('pending', true);
    fixture.detectChanges();
    expect(el().querySelector('.unsynced')?.getAttribute('aria-label')).toBe('Aguardando sincronização');
  });

  it('rótulos de data: hoje, amanhã, ontem e data completa de outro ano', () => {
    render({ dueDate: iso(0) });
    expect(el().querySelector('.tag.mono')?.textContent).toContain('Hoje');
    render({ dueDate: iso(1) });
    expect(el().querySelector('.tag.mono')?.textContent).toContain('Amanhã');
    render({ dueDate: iso(-1) });
    expect(el().querySelector('.tag.mono')?.textContent).toContain('Ontem');
    render({ dueDate: '2031-03-09' });
    expect(el().querySelector('.tag.mono')?.textContent).toContain('09/03/2031');
  });

  it('vencida e pendente aparece como atrasada; vencida mas concluída, não', () => {
    render({ dueDate: iso(-3), status: 'pending' });
    expect(el().querySelector('.tag.overdue')).not.toBeNull();
    render({ dueDate: iso(-3), status: 'completed' });
    expect(el().querySelector('.tag.overdue')).toBeNull();
    render({ dueDate: iso(3), status: 'pending' });
    expect(el().querySelector('.tag.overdue')).toBeNull();
  });

  it('mostra a lista e a descrição quando existem', () => {
    render({ category: 'Campo', description: 'Verificar aterramento' });
    expect(el().textContent).toContain('Campo');
    expect(el().querySelector('.desc')?.textContent).toContain('Verificar aterramento');
  });

  it('o título é escapado (nada de HTML injetado)', () => {
    render({ title: '<img src=x onerror=alert(1)>' });
    expect(el().querySelector('img')).toBeNull();
    expect(el().querySelector('.title')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
