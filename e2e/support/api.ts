import { API, CONSUMER } from './env';

export interface TestUser {
  name: string;
  email: string;
  password: string;
  token: string;
  session: { token: string; expiresAt: string; user: { id: string; email: string; name: string } };
}

export interface ApiTodo {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  priority: 'low' | 'medium' | 'high';
  status: 'pending' | 'completed';
  category: string | null;
  isUrgent: boolean;
  version: number;
  deletedAt: number | null;
}

export interface ConsumerEvent {
  at: string;
  eventId: string;
  type: string;
  aggregateId: string | null;
  version: number;
  attempt: number;
  outcome: string;
  title: string | null;
}

let counter = 0;
/** sufixo único por execução para títulos/e-mails (os testes compartilham o mesmo banco e o mesmo consumidor) */
export const uid = (prefix = 'e2e') => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export async function registerUser(label = 'Teste E2E'): Promise<TestUser> {
  const email = `${uid('user')}@e2e.test`;
  const password = 'E2e@12345';
  const res = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: label, email, password }),
  });
  if (!res.ok) throw new Error(`register falhou: ${res.status} ${await res.text()}`);
  const session = await res.json();
  return { name: label, email, password, token: session.token, session };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

/** Estado do servidor para o usuário (já filtrado, ordenado e sem removidas). */
export async function serverTodos(u: TestUser, query = ''): Promise<ApiTodo[]> {
  const res = await fetch(`${API}/api/todos${query}`, { headers: auth(u) });
  if (!res.ok) throw new Error(`GET /api/todos: ${res.status}`);
  return res.json();
}

/** Cria tarefas direto pela API de sync (simula "outro dispositivo"). */
export async function serverCreate(u: TestUser, fields: Record<string, string | null>, at = Date.now()): Promise<string> {
  const id = crypto.randomUUID();
  const changes = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v, at }]));
  const res = await fetch(`${API}/api/sync`, {
    method: 'POST',
    headers: { ...auth(u), 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor: 0, mutations: [{ opId: crypto.randomUUID(), id, createdAt: at, changes, deletedAt: null }] }),
  });
  if (!res.ok) throw new Error(`sync falhou: ${res.status}`);
  return id;
}

export async function serverEdit(u: TestUser, id: string, fields: Record<string, string | null>, at = Date.now()): Promise<void> {
  const changes = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v, at }]));
  const res = await fetch(`${API}/api/sync`, {
    method: 'POST',
    headers: { ...auth(u), 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor: 0, mutations: [{ opId: crypto.randomUUID(), id, changes, deletedAt: null, createdAt: null }] }),
  });
  if (!res.ok) throw new Error(`sync falhou: ${res.status}`);
}

export async function serverDelete(u: TestUser, id: string, at = Date.now()): Promise<void> {
  const res = await fetch(`${API}/api/sync`, {
    method: 'POST',
    headers: { ...auth(u), 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor: 0, mutations: [{ opId: crypto.randomUUID(), id, changes: {}, deletedAt: at, createdAt: null }] }),
  });
  if (!res.ok) throw new Error(`sync falhou: ${res.status}`);
}

// ---------- consumidor externo simulado ----------

export async function consumerEvents(): Promise<ConsumerEvent[]> {
  const res = await fetch(`${CONSUMER}/api/events`);
  return res.json();
}

/** Eventos de uma tarefa (por título único), do mais antigo para o mais novo. */
export async function consumerEventsFor(titleFragment: string): Promise<ConsumerEvent[]> {
  const all = await consumerEvents();
  return all.filter((e) => e.title?.includes(titleFragment)).reverse();
}

export async function consumerInjectFailures(count: number): Promise<void> {
  await fetch(`${CONSUMER}/admin/failures?count=${count}`, { method: 'POST' });
}

export async function consumerState(): Promise<{ failuresPending: number; todos: { id: string; version: number; data: { title: string } }[] }> {
  const res = await fetch(`${CONSUMER}/api/state`);
  return res.json();
}
