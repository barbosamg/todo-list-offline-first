import { expect, test } from '@playwright/test';
import { addTask, expectFullySynced, expectRail, openAs, row } from '../support/app';
import { registerUser, uid } from '../support/api';

test.describe('Autenticação e sessão', () => {
  test('quem não tem sessão é levado para o login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  });

  test('senha errada mostra o erro e continua no login', async ({ page }) => {
    const user = await registerUser();
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(user.email);
    await page.getByLabel('Senha').fill('senha-errada');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();

    await expect(page.getByRole('alert')).toContainText('E-mail ou senha inválidos');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('login com credenciais corretas abre o app com o estado vazio', async ({ page }) => {
    const user = await registerUser('Maria Teste');
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(user.email);
    await page.getByLabel('Senha').fill(user.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Todas as tarefas' })).toBeVisible();
    await expect(page.getByText('Comece pela primeira tarefa')).toBeVisible();
    await expect(page.locator('app-sidebar')).toContainText('Maria Teste');
    await expectRail(page, 'synced');
  });

  test('cadastro pela interface cria a conta e já entra', async ({ page }) => {
    const email = `${uid('novo')}@e2e.test`;
    await page.goto('/login');
    await page.getByRole('button', { name: 'Criar uma conta' }).click();
    await page.getByLabel('Nome').fill('Pessoa Nova');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill('senha-forte-1');
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('app-sidebar')).toContainText('Pessoa Nova');
  });

  test('cadastro com senha curta é recusado com mensagem', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Criar uma conta' }).click();
    await page.getByLabel('Nome').fill('Fulano');
    await page.getByLabel('E-mail').fill(`${uid('curta')}@e2e.test`);
    await page.getByLabel('Senha').fill('123');
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click();

    await expect(page.getByRole('alert')).toContainText('ao menos 6 caracteres');
  });

  test('e-mail já cadastrado é recusado', async ({ page }) => {
    const user = await registerUser();
    await page.goto('/login');
    await page.getByRole('button', { name: 'Criar uma conta' }).click();
    await page.getByLabel('Nome').fill('Outro');
    await page.getByLabel('E-mail').fill(user.email);
    await page.getByLabel('Senha').fill('senha-forte-1');
    await page.getByRole('button', { name: 'Criar conta', exact: true }).click();

    await expect(page.getByRole('alert')).toContainText('já cadastrado');
  });

  test('o botão de demonstração preenche a conta de teste e entra', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Preencher conta de demonstração' }).click();
    await expect(page.getByLabel('E-mail')).toHaveValue('demo@way2.dev');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('app-sidebar')).toContainText('demo@way2.dev');
  });

  test('sair e entrar de novo mantém as tarefas (local e no servidor)', async ({ page }) => {
    const user = await registerUser();
    await openAs(page, user);
    const title = uid('Persistente');
    await addTask(page, title);
    await expectFullySynced(page);

    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('E-mail').fill(user.email);
    await page.getByLabel('Senha').fill(user.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();

    await expect(row(page, title)).toBeVisible();
  });

  test('sair com alterações pendentes pede confirmação e preserva a fila para o próximo login', async ({ page, context }) => {
    const user = await registerUser();
    await openAs(page, user);
    await context.setOffline(true);
    await expectRail(page, 'offline');
    const title = uid('Pendente ao sair');
    await addTask(page, title);

    let asked = '';
    page.once('dialog', async (d) => { asked = d.message(); await d.accept(); });
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(asked).toMatch(/ainda não enviada/);

    // volta a ter rede, entra de novo: a fila salva é enviada
    await context.setOffline(false);
    await page.getByLabel('E-mail').fill(user.email);
    await page.getByLabel('Senha').fill(user.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();

    await expect(row(page, title)).toBeVisible();
    await expectFullySynced(page);
  });

  test('o app abre offline com a sessão salva (sem pedir login)', async ({ page, context }) => {
    const user = await registerUser();
    await openAs(page, user);
    await addTask(page, uid('Antes de cair'));
    await expectFullySynced(page);

    await context.setOffline(true);
    await page.evaluate(() => (window as unknown as { dispatchEvent(e: Event): void }).dispatchEvent(new Event('offline')));
    await expectRail(page, 'offline');
    await expect(page.getByRole('heading', { name: 'Todas as tarefas' })).toBeVisible();
  });
});
