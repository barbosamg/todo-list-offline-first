import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { addTask, expectFullySynced, openAs, openEditor, row, saveEditor } from '../support/app';
import {
  consumerEvents, consumerEventsFor, consumerInjectFailures, consumerState, registerUser, serverTodos, TestUser, uid,
} from '../support/api';
import { CONSUMER } from '../support/env';

test.describe('Integração externa: outbox → webhook → consumidor (somente leitura)', () => {
  let user: TestUser;

  test.beforeEach(async ({ page }) => {
    user = await registerUser();
    await openAs(page, user);
  });

  test('criar, editar e excluir geram created → updated → deleted, em ordem e com versões crescentes', async ({ page }) => {
    const title = uid('Ciclo de vida');
    await addTask(page, title);
    await expectFullySynced(page);
    await expect.poll(async () => (await consumerEventsFor(title)).length).toBe(1);

    let dlg = await openEditor(page, title);
    await dlg.getByRole('button', { name: 'Alta' }).click();
    await saveEditor(page);
    await expectFullySynced(page);
    await expect.poll(async () => (await consumerEventsFor(title)).length).toBe(2);

    await openEditor(page, title);
    await page.getByRole('dialog').getByRole('button', { name: 'Excluir' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sim, excluir' }).click();

    await expect.poll(async () => (await consumerEventsFor(title)).map((e) => `${e.type}@v${e.version}`)).toEqual([
      'todo.created@v1', 'todo.updated@v2', 'todo.deleted@v3',
    ]);
    const events = await consumerEventsFor(title);
    expect(events.every((e) => e.outcome === 'aplicado')).toBe(true);
    expect(events.every((e) => e.attempt === 1)).toBe(true);
  });

  test('o consumidor projeta o estado da tarefa e remove quando é excluída', async ({ page }) => {
    const title = uid('Projeção');
    await addTask(page, title);
    await expect.poll(async () => (await consumerState()).todos.some((t) => t.data.title === title)).toBe(true);

    await openEditor(page, title);
    await page.getByRole('dialog').getByRole('button', { name: 'Excluir' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sim, excluir' }).click();
    await expect.poll(async () => (await consumerState()).todos.some((t) => t.data.title === title)).toBe(false);
  });

  test('o payload traz o snapshot completo e a flag de urgência', async ({ page }) => {
    const title = `${uid('Snapshot')} urgente`;
    await addTask(page, title);
    await expect.poll(async () => (await consumerState()).todos.find((t) => t.data.title === title)).toBeTruthy();
    const todo = (await consumerState()).todos.find((t) => t.data.title === title)!;
    expect(todo.data).toMatchObject({ title, priority: 'medium', status: 'pending', isUrgent: true });
  });

  test('consumidor fora do ar (503): o produtor tenta de novo com backoff e entrega na tentativa seguinte', async ({ page }) => {
    await consumerInjectFailures(2);
    const title = uid('Retry');
    await addTask(page, title);

    await expect.poll(async () => (await consumerEventsFor(title)).map((e) => `${e.attempt}:${e.outcome}`), { timeout: 40_000 })
      .toEqual(['1:falha-injetada', '2:falha-injetada', '3:aplicado']);
    expect((await consumerState()).failuresPending).toBe(0);
  });

  test('com o consumidor falhando, a ordem por tarefa é preservada: v2 só chega depois da v1', async ({ page }) => {
    const title = uid('Ordem sob falha');
    await addTask(page, title);
    await expectFullySynced(page);
    await expect.poll(async () => (await consumerEventsFor(title)).length).toBe(1);

    await consumerInjectFailures(1);
    const dlg = await openEditor(page, title);
    await dlg.getByRole('button', { name: 'Alta' }).click();
    await saveEditor(page);
    await expectFullySynced(page);
    const dlg2 = await openEditor(page, title);
    await dlg2.getByLabel('Descrição').fill('segunda edição');
    await saveEditor(page);
    await expectFullySynced(page);

    await expect.poll(async () => {
      const applied = (await consumerEventsFor(title)).filter((e) => e.outcome === 'aplicado');
      return applied.map((e) => e.version);
    }, { timeout: 40_000 }).toEqual([1, 2, 3]);
  });

  test('uma falha do consumidor NÃO atrapalha o usuário: o app sincroniza normalmente', async ({ page }) => {
    await consumerInjectFailures(3);
    const title = uid('Usuário não sente');
    await addTask(page, title);

    await expectFullySynced(page); // o sync do dispositivo é independente da entrega externa
    expect((await serverTodos(user)).map((t) => t.title)).toEqual([title]);
    await expect.poll(async () => (await consumerEventsFor(title)).some((e) => e.outcome === 'aplicado'), { timeout: 60_000 }).toBe(true);
  });

  test('o consumidor rejeita eventos com assinatura inválida (HMAC)', async () => {
    const body = JSON.stringify({ eventId: crypto.randomUUID(), type: 'todo.created', aggregate: { id: crypto.randomUUID(), version: 1 }, data: { title: 'forjado' } });
    const res = await fetch(`${CONSUMER}/webhooks/todos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Event-Id': crypto.randomUUID(), 'X-Signature': 'sha256=00' }, body,
    });
    expect(res.status).toBe(401);
    expect((await consumerState()).todos.some((t) => t.data.title === 'forjado')).toBe(false);
  });

  test('evento válido reenviado é aceito, mas deduplicado (idempotência)', async () => {
    const eventId = crypto.randomUUID(); const agg = crypto.randomUUID(); const title = uid('Duplicado');
    const body = JSON.stringify({ eventId, type: 'todo.created', aggregate: { type: 'todo', id: agg, version: 1 }, data: { title } });
    const sig = 'sha256=' + createHmac('sha256', 'dev-shared-secret').update(body).digest('hex');
    const send = () => fetch(`${CONSUMER}/webhooks/todos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Event-Id': eventId, 'X-Signature': sig }, body,
    });

    const first = await (await send()).json();
    const second = await send();

    expect(first.status).toBe('applied');
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe('duplicate');
    expect((await consumerEventsFor(title)).map((e) => e.outcome)).toEqual(['aplicado', 'duplicado-ignorado']);
  });

  test('versão antiga entregue depois da nova é ignorada (não regride a projeção)', async () => {
    const agg = crypto.randomUUID(); const title = uid('Versões');
    const send = async (version: number, t: string) => {
      const body = JSON.stringify({ eventId: crypto.randomUUID(), type: 'todo.updated', aggregate: { type: 'todo', id: agg, version }, data: { title: t } });
      const sig = 'sha256=' + createHmac('sha256', 'dev-shared-secret').update(body).digest('hex');
      return (await fetch(`${CONSUMER}/webhooks/todos`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig, 'X-Event-Id': crypto.randomUUID() }, body })).json();
    };
    expect((await send(5, `${title} nova`)).status).toBe('applied');
    expect((await send(2, `${title} velha`)).status).toBe('stale');
    expect((await consumerState()).todos.find((t) => t.id === agg)?.data.title).toBe(`${title} nova`);
  });

  test('o painel do consumidor mostra os eventos recebidos em tempo real', async ({ page, context }) => {
    const title = uid('Painel');
    await addTask(page, title);

    const painel = await context.newPage();
    await painel.goto(CONSUMER);
    await expect(painel.getByRole('heading', { name: 'Consumidor externo simulado' })).toBeVisible();
    await expect(painel.locator('#events')).toContainText('todo.created', { timeout: 20_000 });
    await expect(painel.locator('#state')).toContainText(title, { timeout: 20_000 });
  });

  test('eventos de usuários diferentes chegam, cada um com o seu dono', async ({ browser }) => {
    const outro = await registerUser();
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await openAs(pg, outro);
    const titulo = uid('Do outro usuário');
    await addTask(pg, titulo);
    await expect.poll(async () => (await consumerEventsFor(titulo)).length).toBe(1);
    await ctx.close();

    const all = await consumerEvents();
    expect(all.some((e) => e.title === titulo)).toBe(true);
  });
});
