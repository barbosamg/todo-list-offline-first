using TodoOffline.Api.Domain;

namespace TodoOffline.Api.Features.Sync;

/// <summary>
/// Uma operação gravada offline. <see cref="Changes"/> contém só os campos que o usuário tocou
/// (patch), cada um com o instante da edição. <see cref="DeletedAt"/> representa a remoção.
/// <see cref="OpId"/> identifica a operação para correlacionar o resultado (reenvios são seguros:
/// o merge é idempotente).
/// </summary>
public sealed record Mutation(
    Guid OpId,
    Guid Id,
    Dictionary<string, FieldChange>? Changes,
    long? DeletedAt,
    long? CreatedAt);

public sealed record SyncRequest(long Cursor, List<Mutation>? Mutations);

public static class MutationStatus
{
    public const string Applied = "applied";
    public const string Noop = "noop";
    public const string Rejected = "rejected";
}

/// <param name="Status">applied | noop | rejected</param>
/// <param name="RejectedFields">campos perdidos para uma edição mais recente (LWW) — informativo.</param>
/// <param name="Error">motivo quando Status = rejected (validação / id de outro usuário).</param>
/// <param name="Current">estado atual no servidor quando rejeitada, para o cliente reconciliar.</param>
public sealed record MutationResult(
    Guid OpId,
    string Status,
    IReadOnlyList<string>? RejectedFields = null,
    string? Error = null,
    TodoDto? Current = null);

public sealed record SyncResponse(
    IReadOnlyList<MutationResult> Results,
    IReadOnlyList<TodoDto> Changes,
    long Cursor,
    bool HasMore);

public sealed record TodoDto(
    Guid Id,
    string Title,
    string? Description,
    string? DueDate,
    string Priority,
    string Status,
    string? Category,
    bool IsUrgent,
    long Version,
    long Seq,
    long CreatedAt,
    long UpdatedAt,
    long? DeletedAt,
    IReadOnlyDictionary<string, long> FieldTimes)
{
    public static TodoDto From(Todo t) => new(
        t.Id, t.Title, t.Description,
        t.DueDate?.ToString("yyyy-MM-dd"),
        TodoMerger.PriorityToWire(t.Priority),
        TodoMerger.StatusToWire(t.Status),
        t.Category, t.IsUrgent, t.Version, t.ServerSeq,
        t.CreatedAt, t.UpdatedAt, t.DeletedAt,
        new Dictionary<string, long>(t.FieldTimes));
}
