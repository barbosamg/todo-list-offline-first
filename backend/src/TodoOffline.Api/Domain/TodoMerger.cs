using System.Globalization;
using System.Text.Json;

namespace TodoOffline.Api.Domain;

/// <summary>Uma edição de campo vinda de um cliente: novo valor + instante (epoch ms) em que o usuário editou.</summary>
public sealed record FieldChange(JsonElement Value, long At);

/// <param name="Changed">true se algum valor de campo efetivamente mudou.</param>
/// <param name="RejectedFields">campos descartados porque o servidor já tinha uma edição mais recente.</param>
/// <param name="Error">erro de validação; quando presente nada foi aplicado.</param>
public sealed record MergeResult(bool Changed, IReadOnlyList<string> RejectedFields, string? Error = null)
{
    public static MergeResult Invalid(string error) => new(false, [], error);
}

/// <summary>
/// Resolução de conflitos: registrador LWW (last-writer-wins) por campo.
/// Cada campo vence pelo maior timestamp de edição; empate é desempatado deterministicamente pelo
/// valor canônico. O resultado independe da ordem/repetição das mensagens (comutativo e idempotente),
/// então reenvios da fila offline e dispositivos concorrentes convergem para o mesmo estado.
/// Edições em campos diferentes nunca conflitam. Remoção é "sticky": uma vez removida, a tarefa não volta.
/// </summary>
public static class TodoMerger
{
    public const int MaxTitle = 200, MaxDescription = 4000, MaxCategory = 50;

    private sealed record FieldDef(
        string Name,
        Func<JsonElement, (string? Value, string? Error)> Parse,
        Func<Todo, string?> Get,
        Action<Todo, string?> Set);

    private static readonly Dictionary<string, FieldDef> Defs = new[]
    {
        new FieldDef("title", e => ParseText(e, MaxTitle, required: true, "title"),
            t => t.Title, (t, v) => t.Title = v!),
        new FieldDef("description", e => ParseText(e, MaxDescription, required: false, "description"),
            t => t.Description, (t, v) => t.Description = v),
        new FieldDef("category", e => ParseText(e, MaxCategory, required: false, "category"),
            t => t.Category, (t, v) => t.Category = v),
        new FieldDef("dueDate", ParseDate,
            t => t.DueDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            (t, v) => t.DueDate = v is null ? null : DateOnly.ParseExact(v, "yyyy-MM-dd", CultureInfo.InvariantCulture)),
        new FieldDef("priority", e => ParseEnum(e, "priority", ["low", "medium", "high"]),
            t => PriorityToWire(t.Priority), (t, v) => t.Priority = PriorityFromWire(v!)),
        new FieldDef("status", e => ParseEnum(e, "status", ["pending", "completed"]),
            t => StatusToWire(t.Status), (t, v) => t.Status = StatusFromWire(v!)),
    }.ToDictionary(d => d.Name);

    public static string PriorityToWire(Priority p) => p switch { Priority.Low => "low", Priority.High => "high", _ => "medium" };
    public static Priority PriorityFromWire(string s) => s switch { "low" => Priority.Low, "high" => Priority.High, _ => Priority.Medium };
    public static string StatusToWire(TodoStatus s) => s == TodoStatus.Completed ? "completed" : "pending";
    public static TodoStatus StatusFromWire(string s) => s == "completed" ? TodoStatus.Completed : TodoStatus.Pending;

    public static MergeResult Apply(Todo todo, IReadOnlyDictionary<string, FieldChange> changes, long nowMs)
    {
        // 1) valida tudo antes de tocar na entidade (mutação atômica)
        var parsed = new List<(FieldDef Def, string? Value, long At)>(changes.Count);
        foreach (var (name, change) in changes)
        {
            if (!Defs.TryGetValue(name, out var def))
                return MergeResult.Invalid($"Campo desconhecido: {name}.");
            var (value, error) = def.Parse(change.Value);
            if (error is not null) return MergeResult.Invalid(error);
            parsed.Add((def, value, Math.Clamp(change.At, 1, nowMs)));
        }

        if (todo.IsDeleted)
            return new MergeResult(false, parsed.Select(p => p.Def.Name).ToList());

        // 2) LWW por campo
        var rejected = new List<string>();
        var changed = false;
        foreach (var (def, value, at) in parsed)
        {
            var currentAt = todo.FieldTimes.GetValueOrDefault(def.Name, 0);
            var current = def.Get(todo);
            if (string.Equals(current, value, StringComparison.Ordinal))
            {
                // Mesmo valor: nada muda para o usuário, mas o instante mais recente PRECISA ser registrado.
                // Sem isso, uma edição antiga (de outro dispositivo) chegando depois venceria uma mais nova
                // que por acaso gravou o mesmo valor — o merge deixaria de ser comutativo.
                if (at > currentAt) todo.FieldTimes[def.Name] = at;
                continue;
            }

            var wins = at > currentAt
                || (at == currentAt && string.CompareOrdinal(value ?? "", current ?? "") > 0);
            if (!wins) { rejected.Add(def.Name); continue; }

            def.Set(todo, value);
            todo.FieldTimes[def.Name] = at;
            changed = true;
        }

        if (changed) todo.IsUrgent = UrgentRule.IsUrgent(todo.Title, todo.Description);
        return new MergeResult(changed, rejected);
    }

    /// <summary>Remove logicamente (tombstone). Retorna false se já estava removida.</summary>
    public static bool Delete(Todo todo, long at, long nowMs)
    {
        if (todo.IsDeleted) return false;
        todo.DeletedAt = Math.Clamp(at, 1, nowMs);
        return true;
    }

    private static (string?, string?) ParseText(JsonElement e, int max, bool required, string field)
    {
        if (e.ValueKind == JsonValueKind.Null) return required ? (null, $"{field} é obrigatório.") : (null, null);
        if (e.ValueKind != JsonValueKind.String) return (null, $"{field} deve ser texto.");
        var text = e.GetString()!.Trim();
        if (text.Length == 0) return required ? (null, $"{field} é obrigatório.") : (null, null);
        if (text.Length > max) return (null, $"{field} excede {max} caracteres.");
        return (text, null);
    }

    private static (string?, string?) ParseDate(JsonElement e)
    {
        if (e.ValueKind == JsonValueKind.Null) return (null, null);
        if (e.ValueKind == JsonValueKind.String && e.GetString() is { Length: 0 }) return (null, null);
        if (e.ValueKind == JsonValueKind.String
            && DateOnly.TryParseExact(e.GetString(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
            return (d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), null);
        return (null, "dueDate deve estar no formato yyyy-MM-dd.");
    }

    private static (string?, string?) ParseEnum(JsonElement e, string field, string[] allowed)
    {
        if (e.ValueKind == JsonValueKind.String && e.GetString() is { } s && allowed.Contains(s)) return (s, null);
        return (null, $"{field} deve ser um de: {string.Join(", ", allowed)}.");
    }
}
