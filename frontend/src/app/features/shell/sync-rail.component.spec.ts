import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { SyncEngine } from '../../core/sync-engine';
import { setOnline, setupApp, tick } from '../../core/testing';
import { TodoRepository } from '../../core/todo-repository';
import { SyncRailComponent } from './sync-rail.component';

describe('SyncRailComponent (indicador de estado)', () => {
  let fixture: ComponentFixture<SyncRailComponent>;
  let engine: SyncEngine;
  let repo: TodoRepository;
  const text = () => (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ');
  const host = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    ({ repo } = await setupApp());
    engine = TestBed.inject(SyncEngine);
    fixture = TestBed.createComponent(SyncRailComponent);
    fixture.detectChanges();
  });

  afterEach(() => engine.stop());

  it('sincronizado: sem tiques e sem contador', () => {
    expect(host().getAttribute('data-state')).toBe('synced');
    expect(text()).toContain('Sincronizado');
    expect(host().querySelectorAll('.ticks i')).toHaveLength(0);
    expect(host().querySelector('.count')).toBeNull();
  });

  it('offline: mostra "Offline" e o contador singular/plural de pendências', async () => {
    setOnline(false);
    await repo.create({ title: 'a' });
    await engine.run();
    fixture.detectChanges();

    expect(host().getAttribute('data-state')).toBe('offline');
    expect(text()).toContain('Offline');
    expect(host().querySelector('.count')?.textContent).toContain('1 pendente');

    await repo.create({ title: 'b' });
    fixture.detectChanges();
    expect(host().querySelector('.count')?.textContent).toContain('2 pendentes');
    expect(host().querySelectorAll('.ticks i')).toHaveLength(2); // um tique por alteração
  });

  it('limita os tiques a 24 e resume o resto como "+N"', async () => {
    setOnline(false);
    for (let i = 0; i < 30; i++) await repo.create({ title: `t${i}` });
    await engine.run();
    fixture.detectChanges();

    expect(host().querySelectorAll('.ticks i')).toHaveLength(24);
    expect(host().querySelector('.more')?.textContent).toContain('+6');
  });

  it('sincronizando: botão desabilitado e ícone girando', () => {
    engine.state.set('syncing');
    fixture.detectChanges();
    expect(host().getAttribute('data-state')).toBe('syncing');
    expect((host().querySelector('.act') as HTMLButtonElement).disabled).toBe(true);
    expect(host().querySelector('.spin')).not.toBeNull();
  });

  it('falha: mostra o texto de falha', () => {
    engine.state.set('error');
    fixture.detectChanges();
    expect(text()).toContain('Falha ao sincronizar');
  });

  it('sessão expirada: o botão vira "Entrar novamente" e leva ao login sem apagar dados locais', async () => {
    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const auth = TestBed.inject(AuthService);
    const logout = vi.spyOn(auth, 'logout');
    await repo.create({ title: 'pendente' });
    engine.state.set('auth');
    fixture.detectChanges();

    const btn = host().querySelector('.act') as HTMLButtonElement;
    expect(btn.textContent).toContain('Entrar novamente');
    btn.click();

    expect(logout).toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith('/login');
    expect(repo.pendingCount()).toBe(1);
  });

  it('o botão "Sincronizar" dispara uma sincronização manual', async () => {
    const spy = vi.spyOn(engine, 'syncNow').mockResolvedValue();
    (host().querySelector('.act') as HTMLButtonElement).click();
    expect(spy).toHaveBeenCalled();
    await tick(1);
  });

  it('mostra há quanto tempo foi a última sincronização', async () => {
    repo.lastSyncedAt.set(Date.now() - 5 * 60_000);
    fixture.detectChanges();
    expect(text()).toContain('há 5 min');

    repo.lastSyncedAt.set(Date.now());
    fixture.detectChanges();
    expect(text()).toContain('agora');
  });
});
