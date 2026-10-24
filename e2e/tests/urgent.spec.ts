import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { addTask, composer, openAs, openEditor, row, rows, saveEditor, statusFilter, titlesOnScreen, toasts } from '../support/app';
import { registerUser, serverCreate, serverTodos, TestUser, uid } from '../support/api';

interface Case { name: string; title: string; description: string | null; urgent: boolean }
const cases: Case[] = JSON.parse(readFileSync(join(__dirname, '../../shared/urgent-rule-cases.json'), 'utf8'));

test.describe('Regra de negócio: tarefas urgentes no topo', () => {
  let user: TestUser;

  test.beforeEach(async ({ page }) => {
    user = await registerUser();
    await openAs(page, user);
  });

  test('os mesmos vetores do backend e do frontend valem na tela (título e descrição, qualquer caixa)', async ({ page }) => {
    const usable = cases.filter((c) => c.title.trim() !== '');
    for (const c of usable) await serverCreate(user, { title: c.title, description: c.description });
    await page.getByRole('button', { name: 'Sincronizar' }).click();
    await expect(rows(page)).toHaveCount(usable.length);

    for (const c of usable) {
      const r = rows(page).filter({ has: page.locator('.title', { hasText: new RegExp(`^${c.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
      await expect(r, c.name).toHaveCount(1);
      await expect(r.locator('.urgent-tag'), c.name).toHaveCount(c.urgent ? 1 : 0);
    }
    // todas as urgentes vêm antes de qualquer não urgente
    const flags = await rows(page).evaluateAll((els) => els.map((e) => e.classList.contains('urgent')));
    expect(flags.join(',')).toMatch(/^(true,)*(false,?)*$/);
  });

  test('criar com "urgente" no título: sobe ao topo na hora, mostra aviso e etiqueta', async ({ page }) => {
    await addTask(page, uid('comum 1'));
    await addTask(page, uid('comum 2'));
    const urgente = uid('Religar disjuntor URGENTE');
    await addTask(page, urgente);

    expect((await titlesOnScreen(page))[0]).toBe(urgente);
    await expect(row(page, urgente)).toHaveClass(/urgent/);
    await expect(row(page, urgente).locator('.urgent-tag')).toContainText('Urgente');
    await expect(toasts(page)).toContainText('fixada no topo');
    await expect(page.getByRole('heading', { name: 'Urgentes' })).toBeVisible();
  });

  for (const variante of ['urgente', 'Urgente', 'URGENTE', 'uRgEnTe']) {
    test(`é case-insensitive: "${variante}"`, async ({ page }) => {
      await addTask(page, uid('base'));
      const t = `${uid('t')} ${variante}`;
      await addTask(page, t);
      expect((await titlesOnScreen(page))[0]).toBe(t);
    });
  }

  test('"urgente" só na descrição também vale (editando a tarefa)', async ({ page }) => {
    const jaUrgente = `${uid('Já urgente')} urgente`;
    await addTask(page, jaUrgente);
    const alvo = uid('Alvo');
    await addTask(page, alvo);
    expect((await titlesOnScreen(page))[0]).toBe(jaUrgente);
    await expect(row(page, alvo).locator('.urgent-tag')).toHaveCount(0);

    const dlg = await openEditor(page, alvo);
    await dlg.getByLabel('Descrição').fill('O cliente pediu com URGENTE prioridade');
    await expect(dlg.locator('.hint')).toContainText('fixada no topo');
    await saveEditor(page);

    // agora as duas são urgentes; vale a ordenação padrão (a mais nova primeiro)
    await expect(row(page, alvo).locator('.urgent-tag')).toHaveCount(1);
    expect(await titlesOnScreen(page)).toEqual([alvo, jaUrgente]);
  });

  test('remover a palavra devolve a tarefa à posição normal', async ({ page }) => {
    const comum = uid('comum');
    await addTask(page, comum);
    const urg = uid('urgente');
    await addTask(page, urg);
    expect((await titlesOnScreen(page))[0]).toBe(urg);

    const dlg = await openEditor(page, urg);
    const semPalavra = urg.replace('urgente', 'rotina');
    await dlg.getByLabel('Título').fill(semPalavra);
    await saveEditor(page);

    await expect(row(page, semPalavra).locator('.urgent-tag')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Urgentes' })).toHaveCount(0);
  });

  test('entre urgentes vale a ordenação padrão: prioridade e depois vencimento', async ({ page }) => {
    const baixa = `${uid('u-baixa')} urgente`;
    const altaTarde = `${uid('u-alta-tarde')} urgente`;
    const altaCedo = `${uid('u-alta-cedo')} urgente`;
    await serverCreate(user, { title: baixa, priority: 'low' });
    await serverCreate(user, { title: altaTarde, priority: 'high', dueDate: '2031-12-01' });
    await serverCreate(user, { title: altaCedo, priority: 'high', dueDate: '2031-01-01' });
    const comumAlta = uid('comum-alta');
    await serverCreate(user, { title: comumAlta, priority: 'high' });
    await page.getByRole('button', { name: 'Sincronizar' }).click();
    await expect(rows(page)).toHaveCount(4);

    expect(await titlesOnScreen(page)).toEqual([altaCedo, altaTarde, baixa, comumAlta]);
  });

  test('urgente concluída continua no topo; os filtros não a tiram de lá', async ({ page }) => {
    const comumAlta = uid('comum');
    await serverCreate(user, { title: comumAlta, priority: 'high' });
    const urgConcluida = `${uid('feita')} urgente`;
    await serverCreate(user, { title: urgConcluida, status: 'completed', priority: 'low' });
    await page.getByRole('button', { name: 'Sincronizar' }).click();
    await expect(rows(page)).toHaveCount(2);

    expect((await titlesOnScreen(page))[0]).toBe(urgConcluida);

    await statusFilter(page, 'Todas').click();
    await page.locator('app-filter-bar').getByRole('group', { name: 'Filtrar por prioridade' }).getByRole('button', { name: 'Baixa' }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(row(page, urgConcluida)).toBeVisible();
  });

  test('o contador do cabeçalho destaca as urgentes pendentes', async ({ page }) => {
    await addTask(page, `${uid('a')} urgente`);
    await addTask(page, `${uid('b')} URGENTE`);
    await expect(page.locator('.heading .urg')).toContainText('2 urgentes');
    await row(page, 'urgente').first().getByRole('button', { name: 'Concluir tarefa' }).click();
    await expect(page.locator('.heading .urg')).toContainText('1 urgente');
  });

  test('o servidor também marca como urgente e entrega ao consumidor com isUrgent', async ({ page }) => {
    const t = `${uid('srv')} urgente`;
    await addTask(page, t);
    await expect.poll(async () => (await serverTodos(user))[0]?.isUrgent).toBe(true);
    const list = await serverTodos(user);
    expect(list[0].title).toBe(t);
  });

  test('palavras parecidas não disparam a regra', async ({ page }) => {
    const t = uid('Urgência e emergência');
    await addTask(page, t);
    await expect(row(page, t).locator('.urgent-tag')).toHaveCount(0);
    await composer(page).fill(''); // sem efeito colateral no campo
  });
});
