namespace TodoOffline.Api.Domain;

/// <summary>
/// Regra de negócio: tarefa cujo título OU descrição contém "urgente" (case-insensitive) é urgente.
/// A mesma regra existe no frontend (frontend/src/app/core/urgent-rule.ts) para funcionar offline;
/// ambos os lados são validados pelos mesmos vetores em shared/urgent-rule-cases.json.
/// </summary>
public static class UrgentRule
{
    public const string Keyword = "urgente";

    public static bool IsUrgent(string? title, string? description) =>
        Contains(title) || Contains(description);

    private static bool Contains(string? text) =>
        !string.IsNullOrEmpty(text) && text.Contains(Keyword, StringComparison.OrdinalIgnoreCase);
}
