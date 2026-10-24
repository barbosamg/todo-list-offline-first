import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Entrar · Campo',
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    title: 'Campo · tarefas offline-first',
    loadComponent: () => import('./features/shell/shell.page').then((m) => m.ShellPage),
  },
  { path: '**', redirectTo: '' },
];
