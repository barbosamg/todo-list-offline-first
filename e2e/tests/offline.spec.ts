import { expect, Page, test } from '@playwright/test';
import {
  addTask, expectFullySynced, expectRail, openAs, openEditor, rail, row, rows, saveEditor,
  titlesOnScreen, toasts, waitForServiceWorker,
} from '../support/app';
import { consumerEventsFor, registerUser, serverCreate, serverTodos, TestUser, uid } from '../support/api';

/** Espera o app reagir ao modo offline do navegador. */
async function goOffline(page: Page): Promise<void> {
  await page.context().setOffline(true);
  await expectRail(page, 'offline');
}

async function goOnline(page: Page): Promise<void> {
  await page.context().setOffline(false);
}

test.describe('Offline-first: tudo funciona sem conexão e sincroniza ao voltar', () => {
  let user: TestUser;

  test.beforeEach(async ({ page }) => {
    user = await registerUser();
    await openAs(page, user);
    await expectFullySynced(page);
  });

  test('indicador: Offline ↔ Sincronizado, com a contagem de pendências', async ({ page }) => {
    await goOffline(page);
    await expect(rail(page)).toContainText('Offline');

    await addTask(page, uid('um'));
    await expect(rail(page).locator('.count')).toContainText('1 pendente');
    await addTask(page, uid('dois'));
    await expect(rail(page).locator('.count')).toContainText('2 pendentes');
    await expect(rail(page).locator('.ticks i')).toHaveCount(2);

    await goOnline(page);
    await expectFullySynced(page);
    await expect(rail(page)).toContainText('Sincronizado');
  });

  test('criar offline: aparece na hora, não vai ao servidor nem ao consumidor, e sincroniza ao voltar', async ({ page }) => {
    await goOffline(page);
    const title = uid('Criada offline');
    const r = await addTask(page, title);
    await expect(r.locator('.unsynced')).toHaveCount(1); // selo "aguardando sincronização"

    // enquanto offline, o servidor e os consumidores externos não sabem de nada
    expect(await serverTodos(user)).toHaveLength(0);
    expect(await consumerEventsFor(title)).toHaveLength(0);

    await goOnline(page);
    await expectFullySynced(page);

    await expect.poll(async () => (await serverTodos(user)).map((t) => t.title)).toEqual([title]);
    await expect.poll(async () => (await consumerEventsFor(title)).map((e) => e.type)).toEqual(['todo.created']);
  });

  test('urgente criada offline sobe ao topo imediatamente, sem servidor', async ({ page }) => {
    await addTask(page, uid('comum antiga'));
    await goOffline(page);
    await addTask(page, uid('comum nova'));
    const urgente = uid('Cliente esperando URGENTE');
    await addTask(page, urgente);

    expect((await titlesOnScreen(page))[0]).toBe(urgente);
    await expect(row(page, urgente).locator('.urgent-tag')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Urgentes' })).toBeVisible();

    await goOnline(page);
    await expectFullySynced(page);
    expect((await titlesOnScreen(page))[0]).toBe(urgente); // continua no topo depois de sincronizar
    await expect.poll(async () => (await serverTodos(user)).find((t) => t.title === urgente)?.isUrgent).toBe(true);
  });

  test('editar offline uma tarefa já sincronizada para conter "urgente": sobe na hora', async ({ page }) => {
    await addTask(page, uid('outra'));
    const alvo = uid('Alvo');
    await addTask(page, alvo);
    await expectFullySynced(page);

    await goOffline(page);
    const dlg = await openEditor(page, alvo);
    await dlg.getByLabel('Descrição').fill('agora é urgente');
    await saveEditor(page);

    expect((await titlesOnScreen(page))[0]).toBe(alvo);
    expect((await serverTodos(user)).find((t) => t.title === alvo)?.isUrgent).toBe(false); // servidor ainda não sabe

    await goOnline(page);
    await expectFullySynced(page);
    await expect.poll(async () => (await serverTodos(user)).find((t) => t.title === alvo)?.isUrgent).toBe(true);
  });

  test('editar, concluir e reabrir offline; o servidor só muda ao reconectar', async ({ page }) => {
    const title = uid('Editar offline');
    await addTask(page, title);
    await expect.poll(async () => (await serverTodos(user)).length).toBe(1);

    await goOffline(page);
    const dlg = await openEditor(page, title);
    await dlg.getByRole('button', { name: 'Alta' }).click();
    await dlg.getByLabel('Lista').fill('Campo');
    await saveEditor(page);
    await row(page, title).getByRole('button', { name: 'Concluir tarefa' }).click();

    await expect(row(page, title)).toHaveClass(/done/);
    const before = (await serverTodos(user))[0];
    expect([before.priority, before.status, before.category]).toEqual(['medium', 'pending', null]);

    await goOnline(page);
    await expectFullySynced(page);
    await expect.poll(async () => {
      const t = (await serverTodos(user))[0];
      return [t.priority, t.status, t.category, t.version];
    }).toEqual(['high', 'completed', 'Campo', 2]);
    await expect.poll(async () => (await consumerEventsFor(title)).map((e) => e.type)).toEqual(['todo.created', 'todo.updated']);
  });

  test('excluir offline uma tarefa sincronizada: some na hora e a exclusão chega ao servidor e ao consumidor', async ({ page }) => {
    const title = uid('Excluir offline');
    await addTask(page, title);
    await expect.poll(async () => (await serverTodos(user)).length).toBe(1);

    await goOffline(page);
    await openEditor(page, title);
    await page.getByRole('dialog').getByRole('button', { name: 'Excluir' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sim, excluir' }).click();
    await expect(row(page, title)).toHaveCount(0);
    expect(await serverTodos(user)).toHaveLength(1);

    await goOnline(page);
    await expectFullySynced(page);
    await expect.poll(async () => (await serverTodos(user)).length).toBe(0);
    await expect.poll(async () => (await consumerEventsFor(title)).map((e) => e.type)).toEqual(['todo.created', 'todo.deleted']);
  });

  test('criar e excluir offline antes de sincronizar: nada é enviado (nem ao servidor, nem ao consumidor)', async ({ page }) => {
    await goOffline(page);
    const efemera = uid('Efêmera');
    await addTask(page, efemera);
    await openEditor(page, efemera);
    await page.getByRole('dialog').getByRole('button', { name: 'Excluir' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sim, excluir' }).click();
    const controle = uid('Controle');
    await addTask(page, controle);
    await expect(rail(page).locator('.count')).toContainText('1 pendente'); // só o controle está na fila

    await goOnline(page);
    await expectFullySynced(page);
    await expect.poll(async () => (await consumerEventsFor(controle)).length).toBe(1);

    expect((await serverTodos(user)).map((t) => t.title)).toEqual([controle]);
    expect(await consumerEventsFor(efemera)).toHaveLength(0);
  });

  test('várias edições da mesma tarefa offline viram uma operação (um único evento final)', async ({ page }) => {
    await goOffline(page);
    const base = uid('Coalescer');
    await addTask(page, base);
    let atual = base;
    for (const nome of ['v2', 'v3', 'v4']) {
      const dlg = await openEditor(page, atual);
      atual = `${base} ${nome}`;
      await dlg.getByLabel('Título').fill(atual);
      await saveEditor(page);
    }
    await expect(rail(page).locator('.count')).toContainText('1 pendente'); // tudo coalescido numa operação

    await goOnline(page);
    await expectFullySynced(page);
    await expect.poll(async () => (await consumerEventsFor(base)).map((e) => `${e.type}:${e.title}`))
      .toEqual([`todo.created:${base} v4`]);
  });

  test('muitas tarefas offline (50) sincronizam em lote ao voltar', async ({ page }) => {
    await goOffline(page);
    const marca = uid('lote');
    for (let i = 0; i < 50; i++) await composer(page).fill(`${marca} ${i}`).then(() => composer(page).press('Enter'));
    await expect(rows(page)).toHaveCount(50);
    await expect(rail(page).locator('.count')).toContainText('50 pendentes');

    await goOnline(page);
    await expectFullySynced(page);
    await expect.poll(async () => (await serverTodos(user)).length, { timeout: 30_000 }).toBe(50);
  });

  test('recarregar a página OFFLINE: o service worker abre o app e os dados continuam lá', async ({ page }) => {
    const antes = uid('Salva antes');
    await addTask(page, antes);
    await expectFullySynced(page);
    await waitForServiceWorker(page);

    await goOffline(page);
    const durante = uid('Feita offline');
    await addTask(page, durante);

    await page.reload();
    await expectRail(page, 'offline');
    await expect(row(page, antes)).toBeVisible();
    await expect(row(page, durante)).toBeVisible(); // a fila sobreviveu ao reload
    await expect(rail(page).locator('.count')).toContainText('1 pendente');

    // continua usável depois do reload
    const depois = uid('Depois do reload');
    await addTask(page, depois);

    await goOnline(page);
    await expectFullySynced(page);
    await expect.poll(async () => (await serverTodos(user)).map((t) => t.title).sort()).toEqual([antes, durante, depois].sort());
  });

  test('fechar e reabrir o app com pendências (nova página) preserva e envia a fila', async ({ page, context }) => {
    await goOffline(page);
    const title = uid('Sobrevive ao fechar');
    await addTask(page, title);
    await page.close();

    const nova = await context.newPage();
    await nova.goto('/');
    await expect(row(nova, title)).toBeVisible();
    await expect(rail(nova).locator('.count')).toContainText('1 pendente');

    await context.setOffline(false);
    await expectFullySynced(nova);
    await expect.poll(async () => (await serverTodos(user)).length).toBe(1);
  });

  test('alterações do servidor (feitas por outro dispositivo) chegam sem recarregar quando o app sincroniza', async ({ page }) => {
    const remota = uid('Veio de outro dispositivo');
    await serverCreate(user, { title: remota, priority: 'high' });
    await page.getByRole('button', { name: 'Sincronizar' }).click();
    await expect(row(page, remota)).toBeVisible();
    await expectFullySynced(page);
  });
});


/**
 * Falhas de rede/servidor simuladas com page.route. O service worker do Angular atende o fetch por conta
 * própria (e o Playwright não intercepta o que o SW faz), então estes testes rodam com o SW bloqueado.
 */
test.describe('Falhas de rede e do servidor', () => {
  test.use({ serviceWorkers: 'block' });
  let user: TestUser;

  test.beforeEach(async ({ page }) => {
    user = await registerUser();
    await openAs(page, user);
    await expectFullySynced(page);
  });

  test('reconexão é automática: sem clicar em nada o estado passa por Sincronizando e volta a Sincronizado', async ({ page }) => {
    await goOffline(page);
    await addTask(page, uid('auto'));
    await page.route('**/api/sync', async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.continue(); });

    await goOnline(page);

    await expectRail(page, 'syncing');
    await expect(rail(page)).toContainText('Sincronizando');
    await expectRail(page, 'synced');
  });

  test('conexão "pendurada" (lie-fi): falha de rede com navigator online vira Offline e recupera sozinha', async ({ page }) => {
    let falhar = true;
    await page.route('**/api/sync', (route) => (falhar ? route.abort('connectionfailed') : route.continue()));
    const title = uid('Lie-fi');
    await addTask(page, title);

    await expectRail(page, 'offline'); // o navegador diz "online", mas o servidor não responde
    await expect(row(page, title).locator('.unsynced')).toHaveCount(1);

    falhar = false; // a rede "volta": a próxima tentativa (backoff de 5s) dá certo
    await expectFullySynced(page);
    await expect.poll(async () => (await serverTodos(user)).length).toBe(1);
  });

  test('erro 500 do servidor: mostra "Falha ao sincronizar", mantém a fila e se recupera', async ({ page }) => {
    let falhar = true;
    await page.route('**/api/sync', (route) => (falhar ? route.fulfill({ status: 500, body: 'erro' }) : route.continue()));
    const title = uid('Erro 500');
    await addTask(page, title);

    await expectRail(page, 'error');
    await expect(rail(page)).toContainText('Falha ao sincronizar');
    await expect(rail(page).locator('.count')).toContainText('1 pendente');

    falhar = false;
    await page.getByRole('button', { name: 'Sincronizar' }).click();
    await expectFullySynced(page);
    await expect.poll(async () => (await serverTodos(user)).length).toBe(1);
  });

  test('resposta perdida: o servidor aplicou mas o cliente não soube; o reenvio não duplica nada', async ({ page }) => {
    let primeira = true;
    await page.route('**/api/sync', async (route) => {
      if (primeira) {
        primeira = false;
        await route.fetch(); // o servidor RECEBE e aplica...
        await route.abort('connectionreset'); // ...mas a resposta se perde
      } else await route.continue();
    });
    const title = uid('Resposta perdida');
    await addTask(page, title);

    await expectFullySynced(page); // retentativa com o mesmo lote
    const todos = await serverTodos(user);
    expect(todos).toHaveLength(1);
    expect(todos[0].version).toBe(1);
    await expect.poll(async () => (await consumerEventsFor(title)).map((e) => e.type)).toEqual(['todo.created']);
  });

  test('operação inválida recusada pelo servidor: aviso de erro e a fila não trava', async ({ page }) => {
    await page.route('**/api/sync', async (route) => {
      const body = route.request().postDataJSON();
      for (const m of body.mutations ?? []) if (m.changes?.priority) m.changes.priority.value = 'inexistente';
      await route.continue({ postData: JSON.stringify(body) });
    });
    await page.getByRole('button', { name: /^Prioridade: Média/ }).click();
    const ruim = uid('Prioridade inválida');
    await addTask(page, ruim);

    await expect(toasts(page)).toContainText('recusada pelo servidor');
    await expectFullySynced(page);
    expect(await serverTodos(user)).toHaveLength(0);
  });

});

function composer(page: Page) {
  return page.getByLabel('Título da nova tarefa');
}
