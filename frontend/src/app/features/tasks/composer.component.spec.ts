import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { NoticeService } from '../../core/notice.service';
import { setupApp, tick } from '../../core/testing';
import { TodoRepository } from '../../core/todo-repository';
import { ComposerComponent } from './composer.component';
import { TaskListState } from './task-list-state';

describe('ComposerComponent', () => {
  let fixture: ComponentFixture<ComposerComponent>;
  let repo: TodoRepository;
  let notices: NoticeService;
  let state: TaskListState;
  const input = () => fixture.nativeElement.querySelector('input.text') as HTMLInputElement;

  async function type(text: string) {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function pressEnter() {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }

  beforeEach(async () => {
    ({ repo } = await setupApp());
    notices = TestBed.inject(NoticeService);
    state = TestBed.inject(TaskListState);
    fixture = TestBed.createComponent(ComposerComponent);
    fixture.detectChanges();
  });

  it('Enter cria a tarefa, limpa o campo na hora e mantém o foco', async () => {
    await type('Medir tensão');
    pressEnter();
    expect(input().value).toBe(''); // limpou antes de gravar
    await tick();

    expect(repo.todos().map((t) => t.title)).toEqual(['Medir tensão']);
  });

  it('Enter com campo vazio ou só espaços não cria nada', async () => {
    await type('   ');
    pressEnter();
    await tick();
    expect(repo.todos()).toHaveLength(0);
  });

  it('Enter repetido rapidamente não duplica a tarefa', async () => {
    await type('Uma só');
    pressEnter();
    pressEnter();
    pressEnter();
    await tick(60);
    expect(repo.todos()).toHaveLength(1);
  });

  it('Enter que confirma composição de IME não envia', async () => {
    await type('文');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    await tick();
    expect(repo.todos()).toHaveLength(0);
  });

  it('botão "Adicionar" fica desabilitado sem texto e habilita ao digitar', async () => {
    const button = fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await type('algo');
    expect(button.disabled).toBe(false);
  });

  it('enviar pelo formulário (botão) também cria', async () => {
    await type('Pelo botão');
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(repo.todos().map((t) => t.title)).toEqual(['Pelo botão']);
  });

  it('o botão de prioridade alterna baixa → média → alta e é aplicado à próxima tarefa', async () => {
    const prio = fixture.nativeElement.querySelector('.prio') as HTMLButtonElement;
    prio.click(); // média -> alta
    fixture.detectChanges();
    await type('Importante');
    pressEnter();
    await tick();
    expect(repo.todos()[0].priority).toBe('high');

    // volta ao padrão para a próxima
    await type('Normal');
    pressEnter();
    await tick();
    expect(repo.todos().find((t) => t.title === 'Normal')!.priority).toBe('medium');
  });

  it('com uma lista selecionada, a tarefa nasce nessa lista', async () => {
    state.category.set('Campo');
    await type('Na lista');
    pressEnter();
    await tick();
    expect(repo.todos()[0].category).toBe('Campo');
  });

  it('"Sem lista" não atribui lista', async () => {
    state.category.set('__none__');
    await type('Solta');
    pressEnter();
    await tick();
    expect(repo.todos()[0].category).toBeNull();
  });

  it('título com "urgente" avisa que foi fixada no topo', async () => {
    await type('Religar disjuntor URGENTE');
    pressEnter();
    await tick();
    expect(notices.notices().some((n) => n.text.includes('fixada no topo'))).toBe(true);
    expect(repo.todos()[0].isUrgent).toBe(true);
  });

  it('título comum não gera aviso', async () => {
    await type('Rotina');
    pressEnter();
    await tick();
    expect(notices.notices()).toHaveLength(0);
  });
});
