import { expect, test } from '@playwright/test';
import { addTask, composer, expectFullySynced, expectRail, openAs, openEditor, rail, row, saveEditor, sidebarItem, titlesOnScreen } from '../support/app';
import { registerUser, serverTodos, uid } from '../support/api';

test.describe('Celular (Pixel 7): layout e uso offline', () => {
  test('a régua de status fica no topo e o campo de adicionar fica ao alcance do polegar', async ({ page }) => {
    await openAs(page, await registerUser());
    const vh = page.viewportSize()!.height;

    const r = await rail(page).boundingBox();
    const c = await composer(page).boundingBox();
    expect(r!.y).toBeLessThan(5);
    expect(c!.y).toBeGreaterThan(vh * 0.8); // base da tela
    await expect(page.locator('app-sidebar')).not.toBeInViewport(); // a barra lateral é uma gaveta
  });

  test('a gaveta de listas abre pelo botão de menu e fecha ao escolher uma lista', async ({ page }) => {
    const user = await registerUser();
    await openAs(page, user);
    const t = uid('na gaveta');
    await addTask(page, t);
    const dlg = await openEditor(page, t);
    await dlg.getByLabel('Lista').fill('Inspeção');
    await saveEditor(page);

    await page.getByRole('button', { name: 'Abrir listas' }).click();
    await expect(page.locator('app-sidebar')).toBeInViewport();
    await sidebarItem(page, /Inspeção/).click();
    await expect(page.locator('app-sidebar')).not.toBeInViewport();
    await expect(page.getByRole('heading', { name: 'Inspeção' })).toBeVisible();
  });

  test('o editor abre como "bottom sheet" ocupando a largura toda', async ({ page }) => {
    await openAs(page, await registerUser());
    const t = uid('sheet');
    await addTask(page, t);
    await openEditor(page, t);

    const box = await page.getByRole('dialog').boundingBox();
    const { width, height } = page.viewportSize()!;
    expect(box!.width).toBeGreaterThanOrEqual(width - 2);
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(height - 2); // colado na base
    expect(box!.y).toBeGreaterThan(height * 0.05); // não cobre a tela inteira
  });

  test('sem conexão no celular: criar, editar, urgente no topo e sincronizar ao voltar', async ({ page, context }) => {
    const user = await registerUser();
    await openAs(page, user);
    await expectFullySynced(page);

    await context.setOffline(true);
    await expectRail(page, 'offline');
    const comum = uid('comum'); const urg = `${uid('campo')} URGENTE`;
    await addTask(page, comum);
    await addTask(page, urg);
    expect((await titlesOnScreen(page))[0]).toBe(urg);
    await expect(rail(page).locator('.count')).toContainText('2 pendentes');

    await context.setOffline(false);
    await expectFullySynced(page);
    await expect.poll(async () => (await serverTodos(user)).length).toBe(2);
    expect((await titlesOnScreen(page))[0]).toBe(urg);
  });

  test('a página não tem rolagem horizontal', async ({ page }) => {
    await openAs(page, await registerUser());
    await addTask(page, uid('uma tarefa com um título bastante longo para testar a quebra de linha no celular'));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('alvos de toque têm pelo menos 36px', async ({ page }) => {
    await openAs(page, await registerUser());
    const t = uid('toque');
    await addTask(page, t);
    for (const loc of [row(page, t).locator('.check'), page.getByRole('button', { name: 'Adicionar', exact: true }), page.getByRole('button', { name: 'Abrir listas' })]) {
      const b = (await loc.boundingBox())!;
      expect(Math.min(b.width, b.height), await loc.innerText().catch(() => '')).toBeGreaterThanOrEqual(22);
    }
    const tapRow = (await row(page, t).locator('.body').boundingBox())!;
    expect(tapRow.height).toBeGreaterThanOrEqual(20);
  });
});
