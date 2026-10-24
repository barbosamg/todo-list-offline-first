import { defineConfig, devices } from '@playwright/test';

/**
 * E2E contra o stack real (docker compose up --build):
 *   app 8080 (nginx + service worker) · API 5080 · consumidor simulado 5100 · PostgreSQL.
 * Usa o Google Chrome instalado (channel: 'chrome'): nenhum download de navegador é necessário.
 * `workers: 1`: o consumidor externo é um recurso global (contador de falhas injetadas), então os
 * testes rodam em sequência para serem determinísticos.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    channel: 'chrome',
    headless: true,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [
    { name: 'desktop', testIgnore: /mobile\.spec\.ts/, use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', testMatch: /mobile\.spec\.ts/, use: { ...devices['Pixel 7'], channel: 'chrome' } },
  ],
});
