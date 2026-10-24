import { Browser, BrowserContext, expect, Page, test } from '@playwright/test';
import { addTask, expectFullySynced, expectRail, openAs, openEditor, rows, row, saveEditor, toasts } from '../support/app';
import { registerUser, serverTodos, TestUser, uid } from '../support/api';

/** Dois "dispositivos" = dois contextos de navegador (cada um com o seu IndexedDB), mesma conta. */
async function device(browser: Browser, user: TestUser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ locale: 'pt-BR' });
  const page = await ctx.newPage();
  await openAs(page, user);
  return { ctx, page };
}

const sync = (page: Page) => page.getByRole('button', { name: 'Sincronizar' }).click();
const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms)); // garante instantes de edição distintos

test.describe('Vários dispositivos e resolução de conflitos', () => {
  let user: TestUser;
  let A: { ctx: BrowserContext; page: Page };
  let B: { ctx: BrowserContext; page: Page };

  test.beforeEach(async ({ browser }) => {
    user = await registerUser();
    A = await device(browser, user);
    B = await device(browser, user);
  });

  test.afterEach(async () => {
    await A.ctx.close();
    await B.ctx.close();
  });

  /** cria no A, sincroniza e leva a tarefa até o B. */
  async function sharedTask(title: string) {
    await addTask(A.page, title);
    await expectFullySynced(A.page);
    await sync(B.page);
    await expect(row(B.page, title)).toBeVisible();
    await expectFullySynced(B.page);
  }

  test('o que um dispositivo cria aparece no outro', async () => {
    const title = uid('Do celular');
    await sharedTask(title);
    await expect(row(B.page, title)).toBeVisible();
  });

  test('edição em um dispositivo chega ao outro, inclusive conclusão', async () => {
    const title = uid('Edição remota');
    await sharedTask(title);

    await row(A.page, title).getByRole('button', { name: 'Concluir tarefa' }).click();
    await expectFullySynced(A.page);
    await sync(B.page);

    await expect(row(B.page, title)).toHaveClass(/done/);
  });

  test('exclusão em um dispositivo some no outro', async () => {
    const title = uid('Apagar remoto');
    await sharedTask(title);

    await openEditor(A.page, title);
    await A.page.getByRole('dialog').getByRole('button', { name: 'Excluir' }).click();
    await A.page.getByRole('dialog').getByRole('button', { name: 'Sim, excluir' }).click();
    await expectFullySynced(A.page);
    await sync(B.page);

    await expect(row(B.page, title)).toHaveCount(0);
  });

  test('campos DIFERENTES editados offline nos dois lados são mesclados', async () => {
    const title = uid('Mesclar');
    await sharedTask(title);
    await A.ctx.setOffline(true); await B.ctx.setOffline(true);
    await expectRail(A.page, 'offline'); await expectRail(B.page, 'offline');

    // A muda a prioridade; B muda a descrição e a lista
    let dlg = await openEditor(A.page, title);
    await dlg.getByRole('button', { name: 'Alta' }).click();
    await saveEditor(A.page);
    dlg = await openEditor(B.page, title);
    await dlg.getByLabel('Descrição').fill('nota do B');
    await dlg.getByLabel('Lista').fill('Campo');
    await saveEditor(B.page);

    await A.ctx.setOffline(false); await expectFullySynced(A.page);
    await B.ctx.setOffline(false); await expectFullySynced(B.page);
    await sync(A.page); await expectFullySynced(A.page);

    for (const p of [A.page, B.page]) {
      const r = row(p, title);
      await expect(r.getByRole('img', { name: 'Prioridade alta' })).toBeVisible();
      await expect(r.locator('.desc')).toContainText('nota do B');
      await expect(r).toContainText('Campo');
    }
    expect((await serverTodos(user))[0]).toMatchObject({ priority: 'high', description: 'nota do B', category: 'Campo' });
  });

  test('MESMO campo: vence a edição mais recente, mesmo que a mais antiga chegue por último', async () => {
    const title = uid('Conflito');
    await sharedTask(title);
    await A.ctx.setOffline(true); await B.ctx.setOffline(true);
    await expectRail(A.page, 'offline'); await expectRail(B.page, 'offline');

    const doA = `${title} A (antiga)`;
    const doB = `${title} B (recente)`;
    let dlg = await openEditor(A.page, title);
    await dlg.getByLabel('Título').fill(doA);
    await saveEditor(A.page);
    await pause();
    dlg = await openEditor(B.page, title);
    await dlg.getByLabel('Título').fill(doB);
    await saveEditor(B.page);

    // B (mais recente) reconecta primeiro; A (mais antiga) chega depois e NÃO pode sobrescrever
    await B.ctx.setOffline(false); await expectFullySynced(B.page);
    await A.ctx.setOffline(false); await expectFullySynced(A.page);

    await expect(row(A.page, doB)).toBeVisible();
    await expect(row(A.page, doA)).toHaveCount(0);
    await expect(toasts(A.page)).toContainText('Conflito resolvido');
    await expect(toasts(A.page)).toContainText('título');
    expect((await serverTodos(user))[0].title).toBe(doB);
  });

  test('MESMO campo, ordem inversa: a mais recente vence também quando reconecta por último', async () => {
    const title = uid('Conflito inverso');
    await sharedTask(title);
    await A.ctx.setOffline(true); await B.ctx.setOffline(true);
    await expectRail(A.page, 'offline'); await expectRail(B.page, 'offline');

    const doA = `${title} A (antiga)`;
    const doB = `${title} B (recente)`;
    let dlg = await openEditor(A.page, title);
    await dlg.getByLabel('Título').fill(doA);
    await saveEditor(A.page);
    await pause();
    dlg = await openEditor(B.page, title);
    await dlg.getByLabel('Título').fill(doB);
    await saveEditor(B.page);

    await A.ctx.setOffline(false); await expectFullySynced(A.page); // a antiga sobe primeiro
    expect((await serverTodos(user))[0].title).toBe(doA);
    await B.ctx.setOffline(false); await expectFullySynced(B.page); // a recente a substitui
    await sync(A.page);

    await expect(row(A.page, doB)).toBeVisible();
    expect((await serverTodos(user))[0].title).toBe(doB);
  });

  test('editar no B uma tarefa que o A excluiu: a exclusão vence e o B é atualizado', async () => {
    const title = uid('Excluída e editada');
    await sharedTask(title);
    await B.ctx.setOffline(true);
    await expectRail(B.page, 'offline');

    const dlg = await openEditor(B.page, title);
    await dlg.getByLabel('Título').fill(`${title} editada no B`);
    await saveEditor(B.page);

    await openEditor(A.page, title);
    await A.page.getByRole('dialog').getByRole('button', { name: 'Excluir' }).click();
    await A.page.getByRole('dialog').getByRole('button', { name: 'Sim, excluir' }).click();
    await expectFullySynced(A.page);

    await B.ctx.setOffline(false);
    await expectFullySynced(B.page);
    await expect(rows(B.page)).toHaveCount(0);
    expect(await serverTodos(user)).toHaveLength(0);
  });

  test('tarefas criadas offline nos dois dispositivos aparecem nos dois depois de sincronizar', async () => {
    await A.ctx.setOffline(true); await B.ctx.setOffline(true);
    await expectRail(A.page, 'offline'); await expectRail(B.page, 'offline');
    const doA = uid('Criada no A'); const doB = uid('Criada no B');
    await addTask(A.page, doA);
    await addTask(B.page, doB);

    await A.ctx.setOffline(false); await expectFullySynced(A.page);
    await B.ctx.setOffline(false); await expectFullySynced(B.page);
    await sync(A.page); await expectFullySynced(A.page);

    for (const p of [A.page, B.page]) {
      await expect(row(p, doA)).toBeVisible();
      await expect(row(p, doB)).toBeVisible();
    }
  });

  test('uma tarefa urgente criada no A sobe ao topo no B quando ele sincroniza', async () => {
    await addTask(B.page, uid('comum'));
    await expectFullySynced(B.page);
    const urgente = `${uid('Do A')} urgente`;
    await addTask(A.page, urgente);
    await expectFullySynced(A.page);

    await sync(B.page);

    await expect(rows(B.page).first()).toContainText(urgente);
    await expect(row(B.page, urgente)).toHaveClass(/urgent/);
  });

  test('o B recebe sozinho (polling) as mudanças do A, sem clicar em nada', async () => {
    const title = uid('Polling');
    await addTask(A.page, title);
    await expectFullySynced(A.page);

    await expect(row(B.page, title)).toBeVisible({ timeout: 40_000 }); // ciclo de 20s
  });

  test('um segundo dispositivo novo baixa todo o histórico (incluindo concluídas)', async ({ browser }) => {
    const t1 = uid('h1'); const t2 = uid('h2');
    await addTask(A.page, t1); await addTask(A.page, t2);
    await row(A.page, t2).getByRole('button', { name: 'Concluir tarefa' }).click();
    await expectFullySynced(A.page);

    const C = await device(browser, user);
    await expect(row(C.page, t1)).toBeVisible();
    await expect(row(C.page, t2)).toHaveClass(/done/);
    await C.ctx.close();
  });
});
