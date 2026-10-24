namespace TodoOffline.Api.Domain;

/// <summary>
/// Ordenação padrão da listagem (idêntica à do frontend):
///   1. urgentes primeiro (regra de negócio, independe de status/filtros);
///   2. dentro de cada grupo: pendentes antes de concluídas;
///   3. prioridade alta → baixa;
///   4. vencimento mais próximo primeiro (sem data por último);
///   5. mais recentes primeiro; Id como desempate estável.
/// </summary>
public static class TodoOrdering
{
    public static IOrderedEnumerable<Todo> Default(IEnumerable<Todo> todos) =>
        todos
            .OrderByDescending(t => t.IsUrgent)
            .ThenBy(t => t.Status)
            .ThenByDescending(t => t.Priority)
            .ThenBy(t => t.DueDate ?? DateOnly.MaxValue)
            .ThenByDescending(t => t.CreatedAt)
            .ThenBy(t => t.Id);
}
