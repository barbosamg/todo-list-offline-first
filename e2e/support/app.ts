import { expect, Locator, Page } from '@playwright/test';
import { TestUser } from './api';

export type RailState = 'synced' | 'syncing' | 'offline' | 'error' | 'auth';

/** Entra direto com a sessão do usuário (sem passar pela tela de login) e espera o app abrir. */
export async function openAs(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.evaluate((s) => localStorage.setItem('campo.session', JSON.stringify(s)), user.session);
  await page.goto('/');
  await expect(page.locator('app-sync-rail')).toBeVisible();
}

export const rail = (page: Page): Locator => page.locator('app-sync-rail');
export const composer = (page: Page): Locator => page.getByLabel('Título da nova tarefa');
export const rows = (page: Page): Locator => page.locator('app-task-row');
export const row = (page: Page, title: string): Locator => rows(page).filter({ hasText: title });
export const toasts = (page: Page): Locator => page.locator('app-toasts');
export const editor = (page: Page): Locator => page.getByRole('dialog', { name: 'Editar tarefa' });

export async function expectRail(page: Page, state: RailState): Promise<void> {
  await expect(rail(page)).toHaveAttribute('data-state', state);
}

/** Régua "Sincronizado" e nenhuma alteração pendente. */
export async function expectFullySynced(page: Page): Promise<void> {
  await expectRail(page, 'synced');
  await expect(rail(page).locator('.count')).toHaveCount(0);
  await expect(page.locator('app-task-row .unsynced')).toHaveCount(0);
}

export async function addTask(page: Page, title: string): Promise<Locator> {
  await composer(page).fill(title);
  await composer(page).press('Enter');
  const r = row(page, title);
  await expect(r).toBeVisible();
  return r;
}

/** Títulos das linhas na ordem em que aparecem na tela (urgentes primeiro). */
export async function titlesOnScreen(page: Page): Promise<string[]> {
  return rows(page).locator('.title').allInnerTexts();
}

export async function openEditor(page: Page, title: string): Promise<Locator> {
  await row(page, title).locator('.body').click();
  const dlg = editor(page);
  await expect(dlg).toBeVisible();
  return dlg;
}

export async function saveEditor(page: Page): Promise<void> {
  await editor(page).getByRole('button', { name: 'Salvar' }).click();
  await expect(editor(page)).toBeHidden();
}

/** Espera o service worker assumir o controle da página (necessário para recarregar offline). */
export async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 60_000 });
}

export const sidebarItem = (page: Page, name: string | RegExp): Locator => page.locator('app-sidebar').getByRole('button', { name });
export const statusFilter = (page: Page, name: string): Locator => page.locator('app-filter-bar').getByRole('group', { name: 'Filtrar por status' }).getByRole('button', { name });
export const priorityFilter = (page: Page, name: string): Locator => page.locator('app-filter-bar').getByRole('group', { name: 'Filtrar por prioridade' }).getByRole('button', { name });
export const searchBox = (page: Page): Locator => page.getByLabel('Buscar tarefas');
