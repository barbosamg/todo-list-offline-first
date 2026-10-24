import { HttpClient } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { setupApp } from './testing';

describe('authInterceptor', () => {
  let http: HttpTestingController;
  let client: HttpClient;
  let auth: AuthService;

  beforeEach(async () => {
    ({ http } = await setupApp({ withInterceptor: true }));
    client = TestBed.inject(HttpClient);
    auth = TestBed.inject(AuthService);
    auth.session.set({ token: 'tok-123', expiresAt: '2030-01-01', user: { id: 'u', email: 'e', name: 'n' } });
  });

  it('envia o Bearer nas chamadas protegidas', () => {
    client.get('/api/todos').subscribe();
    expect(http.expectOne('/api/todos').request.headers.get('Authorization')).toBe('Bearer tok-123');
  });

  it('não envia o token para login/cadastro', () => {
    client.post('/api/auth/login', {}).subscribe();
    expect(http.expectOne('/api/auth/login').request.headers.has('Authorization')).toBe(false);
  });

  it('sem sessão, não envia cabeçalho de autorização', () => {
    auth.session.set(null);
    client.get('/api/todos').subscribe();
    expect(http.expectOne('/api/todos').request.headers.has('Authorization')).toBe(false);
  });

  it('401 marca a sessão como expirada e repassa o erro', async () => {
    const p = firstValueFrom(client.get('/api/sync'));
    http.expectOne('/api/sync').flush({}, { status: 401, statusText: 'Unauthorized' });
    await expect(p).rejects.toMatchObject({ status: 401 });
    expect(auth.expired()).toBe(true);
  });

  it('401 do próprio login (senha errada) NÃO marca a sessão como expirada', async () => {
    const p = firstValueFrom(client.post('/api/auth/login', {}));
    http.expectOne('/api/auth/login').flush({}, { status: 401, statusText: 'Unauthorized' });
    await expect(p).rejects.toBeTruthy();
    expect(auth.expired()).toBe(false);
  });

  it('outros erros não alteram o estado de sessão', async () => {
    const p = firstValueFrom(client.get('/api/todos'));
    http.expectOne('/api/todos').flush({}, { status: 500, statusText: 'Server Error' });
    await expect(p).rejects.toBeTruthy();
    expect(auth.expired()).toBe(false);
  });
});
