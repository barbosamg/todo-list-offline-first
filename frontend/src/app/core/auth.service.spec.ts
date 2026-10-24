import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService, Session } from './auth.service';
import { setupApp } from './testing';

const session: Session = {
  token: 'jwt-token',
  expiresAt: '2030-01-01T00:00:00Z',
  user: { id: 'u1', email: 'ana@test.dev', name: 'Ana' },
};

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(async () => {
    ({ http } = await setupApp());
    auth = TestBed.inject(AuthService);
  });

  it('login guarda a sessão em memória e no localStorage', async () => {
    const p = auth.login('ana@test.dev', 'segredo');
    const req = http.expectOne('/api/auth/login');
    expect(req.request.body).toEqual({ email: 'ana@test.dev', password: 'segredo' });
    req.flush(session);
    await p;

    expect(auth.user()?.name).toBe('Ana');
    expect(auth.token).toBe('jwt-token');
    expect(JSON.parse(localStorage.getItem('campo.session')!).token).toBe('jwt-token');
    expect(auth.lastEmail).toBe('ana@test.dev');
  });

  it('register envia nome, e-mail e senha e já autentica', async () => {
    const p = auth.register('Ana', 'ana@test.dev', 'segredo');
    const req = http.expectOne('/api/auth/register');
    expect(req.request.body).toEqual({ name: 'Ana', email: 'ana@test.dev', password: 'segredo' });
    req.flush(session);
    await p;
    expect(auth.user()?.email).toBe('ana@test.dev');
  });

  it('login recusado traz a mensagem do servidor e não cria sessão', async () => {
    const p = auth.login('ana@test.dev', 'errada');
    http.expectOne('/api/auth/login').flush({ error: 'E-mail ou senha inválidos.' }, { status: 401, statusText: 'Unauthorized' });
    await expect(p).rejects.toThrow('E-mail ou senha inválidos.');
    expect(auth.user()).toBeNull();
    expect(localStorage.getItem('campo.session')).toBeNull();
  });

  it('sem conexão, explica que o primeiro acesso precisa de internet', async () => {
    const p = auth.login('a@b.c', 'x');
    http.expectOne('/api/auth/login').error(new ProgressEvent('error'), { status: 0 });
    await expect(p).rejects.toThrow(/Sem conexão/);
  });

  it('erros de validação do servidor mostram a primeira mensagem', async () => {
    const p = auth.register('', 'x', '1');
    http.expectOne('/api/auth/register').flush({ errors: { email: ['E-mail inválido.'] } }, { status: 400, statusText: 'Bad Request' });
    await expect(p).rejects.toThrow('E-mail inválido.');
  });

  it('erro inesperado vira mensagem genérica', async () => {
    const p = auth.login('a@b.c', 'x');
    http.expectOne('/api/auth/login').flush('boom', { status: 500, statusText: 'Server Error' });
    await expect(p).rejects.toThrow(/Não foi possível/);
  });

  it('logout apaga a sessão mas mantém o último e-mail (e os dados locais ficam no IndexedDB)', async () => {
    const p = auth.login('ana@test.dev', 'segredo');
    http.expectOne('/api/auth/login').flush(session);
    await p;

    auth.logout();

    expect(auth.user()).toBeNull();
    expect(auth.token).toBeNull();
    expect(localStorage.getItem('campo.session')).toBeNull();
    expect(auth.lastEmail).toBe('ana@test.dev');
  });

  it('markExpired sinaliza sessão expirada e um novo login limpa o sinal', async () => {
    auth.markExpired();
    expect(auth.expired()).toBe(true);

    const p = auth.login('ana@test.dev', 'segredo');
    http.expectOne('/api/auth/login').flush(session);
    await p;
    expect(auth.expired()).toBe(false);
  });

  it('restaura a sessão salva ao iniciar (o app abre offline)', () => {
    localStorage.setItem('campo.session', JSON.stringify(session));
    const fresh = TestBed.runInInjectionContext(() => new AuthService());
    expect(fresh.user()?.id).toBe('u1');
    expect(fresh.token).toBe('jwt-token');
  });

  it('sessão corrompida no storage é ignorada', () => {
    localStorage.setItem('campo.session', '{não é json');
    const fresh = TestBed.runInInjectionContext(() => new AuthService());
    expect(fresh.user()).toBeNull();
  });
});
