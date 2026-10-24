import { expect, test } from '@playwright/test';
import {
  addTask, composer, editor, expectFullySynced, openAs, openEditor, row, rows, saveEditor,
  searchBox, sidebarItem, statusFilter, priorityFilter, titlesOnScreen,
} from '../support/app';
import { consumerEventsFor, registerUser, serverCreate, serverTodos, TestUser, uid } from '../support/api';

test.describe('CRUD, listas, filtros e busca', () => {
  let user: TestUser;

  test.beforeEach(async ({ page }) => {
    user = await registerUser();
    await openAs(page, user);
  });

  test('criar com Enter: aparece na hora, sincroniza e fica no servidor com os padrões', async ({ page }) => {
    const title = uid('Medir tensão');
    const r = await addTask(page, title);
    await expect(composer(page)).toHaveValue('');
    await expect(r.locator('.unsynced')).toHaveCount(0);

    const [t] = await serverTodos(user);
    expect(t).toMatchObject({ title, priority: 'medium', status: 'pending', description: null, dueDate: null, category: null, version: 1 });
  });

  test('o botão "Adicionar" também cria e fica desabilitado sem texto', async ({ page }) => {
    const add = page.getByRole('button', { name: 'Adicionar', exact: true });
    await expect(add).toBeDisabled();
    const title = uid('Pelo botão');
    await composer(page).fill(title);
    await expect(add).toBeEnabled();
    await add.click();
    await expect(row(page, title)).toBeVisible();
  });

  test('título só com espaços não cria tarefa', async ({ page }) => {
    await composer(page).fill('     ');
    await composer(page).press('Enter');
    await expect(rows(page)).toHaveCount(0);
  });

  test('a prioridade escolhida no campo de adicionar vai para a tarefa', async ({ page }) => {
    await page.getByRole('button', { name: /^Prioridade: Média/ }).click(); // média → alta
    const title = uid('Alta prioridade');
    await addTask(page, title);
    await expect(row(page, title).getByRole('img', { name: 'Prioridade alta' })).toBeVisible();
    await expect.poll(async () => (await serverTodos(user))[0]?.priority).toBe('high');
  });

  test('editar todos os campos pelo painel e conferir no servidor', async ({ page }) => {
    const title = uid('Editar tudo');
    await addTask(page, title);

    const dlg = await openEditor(page, title);
    await expect(dlg.getByLabel('Título')).toHaveValue(title);
    const novo = `${title} (editada)`;
    await dlg.getByLabel('Título').fill(novo);
    await dlg.getByLabel('Descrição').fill('Verificar o aterramento do lado norte');
    await dlg.getByLabel('Vencimento').fill('2031-05-20');
    await dlg.getByLabel('Lista').fill('Inspeção');
    await dlg.getByRole('button', { name: 'Alta' }).click();
    await saveEditor(page);

    const r = row(page, novo);
    await expect(r).toContainText('Inspeção');
    await expect(r).toContainText('20/05/2031');
    await expect(r.locator('.desc')).toContainText('aterramento');
    await expect(r.getByRole('img', { name: 'Prioridade alta' })).toBeVisible();
    await expect(r.locator('.unsynced')).toHaveCount(0);

    expect((await serverTodos(user))[0]).toMatchObject({
      title: novo, description: 'Verificar o aterramento do lado norte', dueDate: '2031-05-20',
      category: 'Inspeção', priority: 'high', version: 2,
    });
  });

  test('cancelar o painel descarta as alterações; Esc também fecha', async ({ page }) => {
    const title = uid('Não editar');
    await addTask(page, title);
    let dlg = await openEditor(page, title);
    await dlg.getByLabel('Título').fill('NÃO DEVE SALVAR');
    await dlg.getByRole('button', { name: 'Cancelar' }).click();
    await expect(editor(page)).toBeHidden();
    await expect(row(page, title)).toBeVisible();

    dlg = await openEditor(page, title);
    await page.keyboard.press('Escape');
    await expect(editor(page)).toBeHidden();
  });

  test('concluir e reabrir pelo checkbox da linha', async ({ page }) => {
    const title = uid('Concluir');
    const r = await addTask(page, title);

    await r.getByRole('button', { name: 'Concluir tarefa' }).click();
    await expect(r).toHaveClass(/done/);
    await expect.poll(async () => (await serverTodos(user))[0]?.status).toBe('completed');

    await r.getByRole('button', { name: 'Reabrir tarefa' }).click();
    await expect(r).not.toHaveClass(/done/);
    await expect.poll(async () => (await serverTodos(user))[0]?.status).toBe('pending');
  });

  test('concluídas vão para o fim da lista', async ({ page }) => {
    const a = uid('A primeira'); const b = uid('B segunda');
    await addTask(page, a);
    await addTask(page, b);
    await row(page, a).getByRole('button', { name: 'Concluir tarefa' }).click();
    await expect.poll(() => titlesOnScreen(page)).toEqual([b, a]);
  });

  test('excluir pede confirmação, remove da lista e do servidor, e gera evento de exclusão', async ({ page }) => {
    const title = uid('Excluir');
    await addTask(page, title);
    await expect.poll(async () => (await serverTodos(user)).length).toBe(1);

    await openEditor(page, title);
    await editor(page).getByRole('button', { name: 'Excluir' }).click();
    await expect(editor(page)).toContainText('Excluir esta tarefa?');
    await editor(page).getByRole('button', { name: 'Não' }).click();
    await expect(row(page, title)).toBeVisible();

    await editor(page).getByRole('button', { name: 'Excluir' }).click();
    await editor(page).getByRole('button', { name: 'Sim, excluir' }).click();

    await expect(row(page, title)).toHaveCount(0);
    await expect.poll(async () => (await serverTodos(user)).length).toBe(0);
    await expect.poll(async () => (await consumerEventsFor(title)).map((e) => e.type)).toContain('todo.deleted');
  });

  test('o cabeçalho conta as pendentes e atualiza ao concluir', async ({ page }) => {
    await addTask(page, uid('um'));
    const b = uid('dois');
    await addTask(page, b);
    await expect(page.locator('.heading p')).toContainText('2 pendentes');
    await row(page, b).getByRole('button', { name: 'Concluir tarefa' }).click();
    await expect(page.locator('.heading p')).toContainText('1 pendente');
  });

  test.describe('listas (agrupamento)', () => {
    test('atribuir uma lista cria o item na barra lateral com contagem e permite filtrar', async ({ page }) => {
      const campo = uid('Campo'); const casa = uid('Casa');
      const t1 = uid('t1'); const t2 = uid('t2'); const t3 = uid('t3');
      await addTask(page, t1); await addTask(page, t2); await addTask(page, t3);
      for (const [t, lista] of [[t1, campo], [t2, campo], [t3, casa]] as const) {
        const dlg = await openEditor(page, t);
        await dlg.getByLabel('Lista').fill(lista);
        await saveEditor(page);
      }

      await expect(sidebarItem(page, new RegExp(campo))).toContainText('2');
      await expect(sidebarItem(page, new RegExp(casa))).toContainText('1');

      await sidebarItem(page, new RegExp(campo)).click();
      await expect(page.getByRole('heading', { name: campo })).toBeVisible();
      await expect(rows(page)).toHaveCount(2);

      await sidebarItem(page, /Todas as tarefas/).click();
      await expect(rows(page)).toHaveCount(3);
    });

    test('nova tarefa criada dentro de uma lista já nasce nela', async ({ page }) => {
      const lista = uid('Obra');
      const t = uid('semente');
      await addTask(page, t);
      const dlg = await openEditor(page, t);
      await dlg.getByLabel('Lista').fill(lista);
      await saveEditor(page);

      await sidebarItem(page, new RegExp(lista)).click();
      const nova = uid('dentro');
      await addTask(page, nova);
      await expect(row(page, nova)).toContainText(lista);
      await expect.poll(async () => (await serverTodos(user)).find((x) => x.title === nova)?.category).toBe(lista);
    });

    test('"Sem lista" mostra só as tarefas sem lista', async ({ page }) => {
      const comLista = uid('com'); const sem = uid('sem');
      await addTask(page, comLista); await addTask(page, sem);
      const dlg = await openEditor(page, comLista);
      await dlg.getByLabel('Lista').fill(uid('L'));
      await saveEditor(page);

      await sidebarItem(page, /Sem lista/).click();
      await expect(rows(page)).toHaveCount(1);
      await expect(row(page, sem)).toBeVisible();
    });
  });

  test.describe('filtros e busca', () => {
    let alta: string, baixa: string, concluida: string, textoUnico: string;

    test.beforeEach(async ({ page }) => {
      alta = uid('Alta'); baixa = uid('Baixa'); concluida = uid('Feita'); textoUnico = uid('zebra');
      await serverCreate(user, { title: alta, priority: 'high', description: textoUnico });
      await serverCreate(user, { title: baixa, priority: 'low' });
      await serverCreate(user, { title: concluida, status: 'completed' });
      await page.getByRole('button', { name: 'Sincronizar' }).click();
      await expect(rows(page)).toHaveCount(3);
    });

    test('por status', async ({ page }) => {
      await statusFilter(page, 'Concluídas').click();
      await expect(rows(page)).toHaveCount(1);
      await expect(row(page, concluida)).toBeVisible();

      await statusFilter(page, 'Pendentes').click();
      await expect(rows(page)).toHaveCount(2);
      await expect(row(page, concluida)).toHaveCount(0);

      await statusFilter(page, 'Todas').click();
      await expect(rows(page)).toHaveCount(3);
    });

    test('por prioridade', async ({ page }) => {
      await priorityFilter(page, 'Alta').click();
      await expect(rows(page)).toHaveCount(1);
      await expect(row(page, alta)).toBeVisible();
      await priorityFilter(page, 'Baixa').click();
      await expect(rows(page)).toHaveCount(1);
      await expect(row(page, baixa)).toBeVisible();
    });

    test('busca por texto no título ou na descrição, sem diferenciar maiúsculas', async ({ page }) => {
      await searchBox(page).fill(textoUnico.toUpperCase());
      await expect(rows(page)).toHaveCount(1);
      await expect(row(page, alta)).toBeVisible();
    });

    test('busca ignora acentos', async ({ page }) => {
      const acento = uid('Reunião');
      await addTask(page, acento);
      await searchBox(page).fill(acento.replace('ã', 'a').toLowerCase());
      await expect(rows(page)).toHaveCount(1);
    });

    test('filtros combinados, estado vazio e "Limpar"', async ({ page }) => {
      await statusFilter(page, 'Concluídas').click();
      await priorityFilter(page, 'Alta').click();
      await expect(page.getByText('Nenhuma tarefa encontrada')).toBeVisible();

      await page.locator('app-filter-bar').getByRole('button', { name: 'Limpar' }).click();
      await expect(rows(page)).toHaveCount(3);
      await expect(page.getByText('Nenhuma tarefa encontrada')).toHaveCount(0);
    });

    test('a tecla "/" foca a busca', async ({ page }) => {
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('/');
      await expect(searchBox(page)).toBeFocused();
    });
  });

  test('vencimentos: "Hoje" e atrasada', async ({ page }) => {
    const hoje = uid('Vence hoje'); const velha = uid('Atrasada');
    const iso = await page.evaluate(() => {
      const d = new Date();
      const f = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
      const p = new Date(d); p.setDate(p.getDate() - 5);
      return { hoje: f(d), passado: f(p) };
    });
    await serverCreate(user, { title: hoje, dueDate: iso.hoje });
    await serverCreate(user, { title: velha, dueDate: iso.passado });
    await page.getByRole('button', { name: 'Sincronizar' }).click();

    await expect(row(page, hoje)).toContainText('Hoje');
    await expect(row(page, hoje).locator('.overdue')).toHaveCount(0);
    await expect(row(page, velha).locator('.overdue')).toHaveCount(1);
  });

  test('ordem padrão: pendentes por prioridade, depois vencimento', async ({ page }) => {
    const baixa = uid('baixa'); const media = uid('media'); const altaCedo = uid('altaCedo'); const altaTarde = uid('altaTarde');
    await serverCreate(user, { title: baixa, priority: 'low' });
    await serverCreate(user, { title: media, priority: 'medium' });
    await serverCreate(user, { title: altaTarde, priority: 'high', dueDate: '2031-12-01' });
    await serverCreate(user, { title: altaCedo, priority: 'high', dueDate: '2031-01-01' });
    await page.getByRole('button', { name: 'Sincronizar' }).click();
    await expect(rows(page)).toHaveCount(4);

    expect(await titlesOnScreen(page)).toEqual([altaCedo, altaTarde, media, baixa]);
    await expectFullySynced(page);
  });
});
