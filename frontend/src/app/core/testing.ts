import 'fake-indexeddb/auto';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { authInterceptor } from './auth.interceptor';
import { TodoRepository } from './todo-repository';

/** Controla navigator.onLine nos testes. */
export function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

/** Configura o TestBed com HTTP simulado e abre um IndexedDB novo (um usuário novo por teste). */
export async function setupApp(options: { withInterceptor?: boolean } = {}) {
  localStorage.clear();
  setOnline(true);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(...(options.withInterceptor ? [withInterceptors([authInterceptor])] : [])),
      provideHttpClientTesting(),
    ],
  });
  const repo = TestBed.inject(TodoRepository);
  await repo.init(`user-${crypto.randomUUID()}`);
  return { repo, http: TestBed.inject(HttpTestingController) };
}

/** deixa microtarefas e o IndexedDB falso assentarem */
export const tick = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));
