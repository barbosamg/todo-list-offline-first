import { expect, test } from '@playwright/test';
import { addTask, expectFullySynced, expectRail, openAs, rail, row, rows } from '../support/app';
import { registerUser, serverCreate, serverTodos, uid } from '../support/api';
import { API } from '../support/env';

test.describe('Isolamento entre usuários', () => {
  test('cada usuário vê apenas as próprias tarefas (UI e API)', async ({ browser }) => {
    const ana = await registerUser('Ana'); const bia = await registerUser('Bia');
    const daAna = uid('Segredo da Ana'); const daBia = uid('Plano da Bia');
    await serverCreate(ana, { title: daAna });
    await serverCreate(bia, { title: daBia });

    const ctxA = await browser.newContext(); const pa = await ctxA.newPage();
    const ctxB = await browser.newContext(); const pb = await ctxB.newPage();
    await openAs(pa, ana); await openAs(pb, bia);

    await expect(row(pa, daAna)).toBeVisible();
    await expect(row(pa, daBia)).toHaveCount(0);
    await expect(row(pb, daBia)).toBeVisible();
    await expect(row(pb, daAna)).toHaveCount(0);
    expect((await serverTodos(ana)).map((t) => t.title)).toEqual([daAna]);
    expect((await serverTodos(bia)).map((t) => t.title)).toEqual([daBia]);
    await ctxA.close(); await ctxB.close();
  });

  test('um usuário não consegue alterar nem excluir a tarefa de outro (id roubado é recusado)', async () => {
    const ana = await registerUser(); const bia = await registerUser();
    const id = await serverCreate(ana, { title: uid('da Ana') });

    const res = await fetch(`${API}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bia.token}` },
      body: JSON.stringify({ cursor: 0, mutations: [
        { opId: crypto.randomUUID(), id, changes: { title: { value: 'sequestrada', at: Date.now() + 1000 } }, deletedAt: null, createdAt: null },
        { opId: crypto.randomUUID(), id, changes: {}, deletedAt: Date.now() + 1000, createdAt: null },
      ] }),
    });
    const body = await res.json();

    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['rejected', 'rejected']);
    expect(body.changes).toHaveLength(0);
    expect((await serverTodos(ana))[0].title).not.toBe('sequestrada');
  });

  test('a API exige autenticação', async () => {
    expect((await fetch(`${API}/api/todos`)).status).toBe(401);
    expect((await fetch(`${API}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${API}/api/todos`, { headers: { Authorization: 'Bearer lixo' } })).status).toBe(401);
  });

  test('cada conta tem o seu banco local: trocar de usuário no mesmo navegador não mistura dados', async ({ page }) => {
    const ana = await registerUser('Ana'); const bia = await registerUser('Bia');
    const daAna = uid('Só da Ana');
    await openAs(page, ana);
    await addTask(page, daAna);
    await expectFullySynced(page);

    await openAs(page, bia); // mesmo navegador, outra conta
    await expect(row(page, daAna)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(0);

    await openAs(page, ana);
    await expect(row(page, daAna)).toBeVisible();
  });
});

test.describe('Sessão expirada', () => {
  test.use({ serviceWorkers: 'block' }); // page.route não enxerga o que o service worker busca

  test('token inválido: o app avisa "Sessão expirada", NÃO perde nada local e retoma após novo login', async ({ page }) => {
    const user = await registerUser();
    await openAs(page, user);
    const antes = uid('Antes de expirar');
    await addTask(page, antes);
    await expectFullySynced(page);

    // simula o servidor passando a recusar o token (expirou/revogado)
    await page.route('**/api/sync', (route) => route.fulfill({ status: 401, body: '{}' }));
    const pendente = uid('Criada com sessão expirada');
    await addTask(page, pendente);

    await expectRail(page, 'auth');
    await expect(rail(page)).toContainText('Sessão expirada');
    await expect(rail(page).getByRole('button', { name: 'Entrar novamente' })).toBeVisible();
    await expect(row(page, antes)).toBeVisible(); // o app continua utilizável
    await expect(row(page, pendente)).toBeVisible();

    await page.unroute('**/api/sync');
    await rail(page).getByRole('button', { name: 'Entrar novamente' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('E-mail').fill(user.email);
    await page.getByLabel('Senha').fill(user.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();

    await expect(row(page, pendente)).toBeVisible();
    await expectFullySynced(page); // a fila guardada foi enviada
    await expect.poll(async () => (await serverTodos(user)).map((t) => t.title).sort()).toEqual([antes, pendente].sort());
  });
});
