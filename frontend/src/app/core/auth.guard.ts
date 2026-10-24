import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { SyncEngine } from './sync-engine';
import { TodoRepository } from './todo-repository';

/**
 * Libera o app a quem tem sessão salva — mesmo offline (o token só é cobrado na sincronização) — e
 * abre o banco local do usuário antes de exibir a tela, para que os dados apareçam instantaneamente.
 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const repo = inject(TodoRepository);
  const engine = inject(SyncEngine);
  const router = inject(Router);

  const user = auth.user();
  if (!user) return router.parseUrl('/login');

  if (repo.userId !== user.id || !repo.ready()) await repo.init(user.id);
  engine.start();
  return true;
};

/** Quem já tem sessão válida não precisa ver o login. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.user() && !auth.expired() ? router.parseUrl('/') : true;
};
