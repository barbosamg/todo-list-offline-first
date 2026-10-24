import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface Session {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

const KEY = 'campo.session';
const LAST_EMAIL = 'campo.lastEmail';

/**
 * Sessão guardada no dispositivo. Offline o app continua abrindo com a sessão salva (os dados são
 * locais); o token só é exigido pelo servidor na sincronização. Se expirar, o app segue funcionando
 * e pede novo login para voltar a sincronizar — nada da fila offline se perde.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly session = signal<Session | null>(read());
  readonly user = computed(() => this.session()?.user ?? null);
  /** o servidor respondeu 401 (token vencido/inválido) */
  readonly expired = signal(false);

  get token(): string | null {
    return this.session()?.token ?? null;
  }

  get lastEmail(): string {
    return safe(() => localStorage.getItem(LAST_EMAIL)) ?? '';
  }

  async login(email: string, password: string): Promise<void> {
    await this.authenticate('/api/auth/login', { email, password });
  }

  async register(name: string, email: string, password: string): Promise<void> {
    await this.authenticate('/api/auth/register', { name, email, password });
  }

  markExpired(): void {
    this.expired.set(true);
  }

  logout(): void {
    this.session.set(null);
    this.expired.set(false);
    safe(() => localStorage.removeItem(KEY));
  }

  private async authenticate(url: string, body: object): Promise<void> {
    try {
      const res = await firstValueFrom(this.http.post<Session>(url, body));
      this.session.set(res);
      this.expired.set(false);
      safe(() => {
        localStorage.setItem(KEY, JSON.stringify(res));
        localStorage.setItem(LAST_EMAIL, res.user.email);
      });
    } catch (e) {
      throw new Error(messageOf(e));
    }
  }
}

function read(): Session | null {
  const raw = safe(() => localStorage.getItem(KEY));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null; // storage bloqueado (modo privado etc.)
  }
}

function messageOf(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) return 'Sem conexão com o servidor. Conecte-se à internet para entrar.';
    const body = e.error as { error?: string; errors?: Record<string, string[]> } | null;
    if (body?.error) return body.error;
    if (body?.errors) return Object.values(body.errors).flat()[0] ?? 'Dados inválidos.';
  }
  return 'Não foi possível concluir. Tente novamente.';
}
