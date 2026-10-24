import { expect, test } from '@playwright/test';
import { addTask, expectFullySynced, openAs, waitForServiceWorker } from '../support/app';
import { registerUser } from '../support/api';
import { API, APP, CONSUMER } from '../support/env';

test.describe('PWA, serviço e infraestrutura', () => {
  test('o service worker é registrado, assume o controle e guarda o app shell', async ({ page }) => {
    await openAs(page, await registerUser());
    await waitForServiceWorker(page);

    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const keys = await caches.keys();
      return { active: !!reg?.active, caches: keys };
    });
    expect(info.active).toBe(true);
    expect(info.caches.some((k) => k.includes(':assets:app:cache'))).toBe(true);
    expect(info.caches.some((k) => k.includes(':assets:assets:cache'))).toBe(true); // fontes e ícones pré-carregados
  });

  test('o manifesto é válido e instalável (nome, ícones, cores, modo standalone)', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    const m = await res.json();
    expect(m).toMatchObject({ short_name: 'Campo', display: 'standalone', lang: 'pt-BR' });
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of m.icons) expect((await request.get(`/${icon.src}`)).ok()).toBe(true);
  });

  test('o service worker e o manifesto de versões não ficam em cache HTTP (o app consegue atualizar)', async ({ request }) => {
    for (const path of ['/ngsw-worker.js', '/ngsw.json', '/index.html']) {
      const res = await request.get(path);
      expect(res.headers()['cache-control'], path).toContain('no-cache');
    }
    // arquivos com hash no nome, ao contrário, têm cache longo
    const html = await (await request.get('/index.html')).text();
    const js = html.match(/src="(main-[^"]+\.js)"/)?.[1];
    expect(js).toBeTruthy();
    expect((await request.get(`/${js}`)).headers()['cache-control']).toContain('immutable');
  });

  test('rotas desconhecidas caem no app (SPA) e a API passa pelo proxy do nginx', async ({ request }) => {
    const spa = await request.get('/qualquer/rota/inexistente');
    expect(spa.status()).toBe(200);
    expect(await spa.text()).toContain('<app-root>');
    const health = await request.get('/api/health');
    expect(await health.json()).toEqual({ status: 'ok' });
  });

  test('a API expõe saúde e a documentação OpenAPI/Scalar', async () => {
    expect((await (await fetch(`${API}/api/health`)).json()).status).toBe('ok');
    expect((await fetch(`${API}/scalar`)).status).toBe(200);
    const spec = await (await fetch(`${API}/openapi/v1.json`)).json();
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/api/sync', '/api/todos', '/api/auth/login', '/api/auth/register']));
  });

  test('o painel do consumidor externo está no ar', async ({ page }) => {
    await page.goto(CONSUMER);
    await expect(page.getByRole('heading', { name: 'Consumidor externo simulado' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Injetar falha (503)' })).toBeVisible();
  });

  test('o app carrega sem erros no console nem requisições com falha', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const failed: string[] = [];
    page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()}`));

    await openAs(page, await registerUser());
    await addTask(page, 'verificando erros');
    await expectFullySynced(page);

    expect(errors).toEqual([]);
    expect(failed).toEqual([]);
  });

  test('tipografia e ícones são servidos pelo próprio app (nada de CDN externa)', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (!['localhost', '127.0.0.1'].includes(u.hostname)) external.push(r.url()); });
    await openAs(page, await registerUser());
    await expectFullySynced(page);
    expect(external).toEqual([]);
    expect(APP).toContain('localhost');
  });
});
