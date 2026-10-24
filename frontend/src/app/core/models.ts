export type Priority = 'low' | 'medium' | 'high';
export type Status = 'pending' | 'completed';

export const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high'];

/** Campos editáveis: cada um tem o seu próprio "relógio" (LWW por campo), igual ao servidor. */
export const EDITABLE_FIELDS = ['title', 'description', 'dueDate', 'priority', 'status', 'category'] as const;
export type Field = (typeof EDITABLE_FIELDS)[number];

export interface Todo {
  id: string;
  title: string;
  description: string | null;
  /** yyyy-MM-dd */
  dueDate: string | null;
  priority: Priority;
  status: Status;
  category: string | null;
  /** Sempre recalculado localmente (core/urgent-rule.ts): a regra funciona offline. */
  isUrgent: boolean;
  version: number;
  seq: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** epoch ms da última edição de cada campo */
  fieldTimes: Record<string, number>;
}

export type FieldValue = string | null;
export interface FieldChange {
  value: FieldValue;
  at: number;
}
export type Changes = Partial<Record<Field, FieldChange>>;

/** Operação gravada localmente, aguardando envio (a "fila offline" / outbox do dispositivo). */
export interface OutboxOp {
  /** chave autoincrement do IndexedDB (ordem de gravação) */
  seq?: number;
  opId: string;
  id: string;
  changes: Changes;
  deletedAt: number | null;
  createdAt: number | null;
}

/** Formato do /api/sync */
export interface WireMutation {
  opId: string;
  id: string;
  changes: Changes;
  deletedAt: number | null;
  createdAt: number | null;
}
export interface MutationResult {
  opId: string;
  status: 'applied' | 'noop' | 'rejected';
  rejectedFields?: string[] | null;
  error?: string | null;
  current?: Todo | null;
}
export interface SyncResponse {
  results: MutationResult[];
  changes: Todo[];
  cursor: number;
  hasMore: boolean;
}

export interface EditableValues {
  title: string;
  description: string | null;
  dueDate: string | null;
  priority: Priority;
  status: Status;
  category: string | null;
}

export const PRIORITY_LABEL: Record<Priority, string> = { low: 'Baixa', medium: 'Média', high: 'Alta' };
export const PRIORITY_RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2 };
