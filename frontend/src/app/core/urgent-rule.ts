/**
 * Regra de negócio: tarefa cujo título OU descrição contém "urgente" (case-insensitive) é urgente.
 * Roda no dispositivo, então vale offline e a tarefa sobe ao topo imediatamente.
 * Espelha backend/.../Domain/UrgentRule.cs; ambos são testados com shared/urgent-rule-cases.json.
 */
export const URGENT_KEYWORD = 'urgente';

export function isUrgent(title: string | null | undefined, description: string | null | undefined): boolean {
  return contains(title) || contains(description);
}

function contains(text: string | null | undefined): boolean {
  return !!text && text.toLowerCase().includes(URGENT_KEYWORD);
}
