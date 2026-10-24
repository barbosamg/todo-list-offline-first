using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TodoOffline.Api.Domain;
using TodoOffline.Api.Infrastructure;
using TodoOffline.Api.Outbox;

namespace TodoOffline.Api.Features.Sync;

/// <summary>
/// Reconciliação servidor ⇄ dispositivos. Um único endpoint faz push (aplica a fila offline) e
/// pull (devolve tudo que mudou desde o cursor) numa ida e volta.
/// </summary>
public sealed class SyncService(AppDbContext db, TimeProvider clock, OutboxSignal signal)
{
    public const int MaxMutationsPerRequest = 200;
    public const int PullPageSize = 200;

    private static readonly JsonSerializerOptions EventJson = new(JsonSerializerDefaults.Web);

    public async Task<SyncResponse> SyncAsync(Guid userId, SyncRequest request, CancellationToken ct)
    {
        var results = request.Mutations is { Count: > 0 }
            ? await ApplyMutationsAsync(userId, request.Mutations, ct)
            : [];

        var (changes, cursor, hasMore) = await PullAsync(userId, request.Cursor, ct);
        return new SyncResponse(results, changes, cursor, hasMore);
    }

    private async Task<List<MutationResult>> ApplyMutationsAsync(Guid userId, List<Mutation> mutations, CancellationToken ct)
    {
        var results = new List<MutationResult>(mutations.Count);
        var now = clock.GetUtcNow();
        var nowMs = now.ToUnixTimeMilliseconds();

        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // Lock da linha do usuário até o commit: serializa as escritas do mesmo usuário, de modo que
        // a ordem de ServerSeq == ordem de commit e o cursor de pull nunca pula uma mudança.
        var locked = await db.Users.Where(u => u.Id == userId)
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.SyncSeq, u => u.SyncSeq), ct);
        if (locked == 0) throw new InvalidOperationException("Usuário inexistente.");
        var seq = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.SyncSeq).SingleAsync(ct);

        var subscriptions = await db.WebhookSubscriptions.AsNoTracking()
            .Where(s => s.Enabled).Select(s => s.Id).ToListAsync(ct);

        var anyEvent = false;
        var touched = new Dictionary<Guid, Todo>(); // várias operações da fila podem tocar a mesma tarefa
        foreach (var m in mutations)
        {
            if (!touched.TryGetValue(m.Id, out var todo))
                todo = await db.Todos.FirstOrDefaultAsync(t => t.Id == m.Id, ct);
            if (todo is not null && todo.UserId != userId)
            {
                results.Add(new(m.OpId, MutationStatus.Rejected, Error: "Identificador já utilizado."));
                continue;
            }

            var isNew = todo is null;
            var changes = m.Changes ?? [];

            if (isNew)
            {
                if (changes.Count == 0)
                {
                    // Remoção/edição de algo que o servidor nunca viu: nada a fazer.
                    results.Add(new(m.OpId, MutationStatus.Noop));
                    continue;
                }
                todo = new Todo
                {
                    Id = m.Id,
                    UserId = userId,
                    CreatedAt = Math.Clamp(m.CreatedAt ?? nowMs, 1, nowMs),
                };
            }

            var merge = TodoMerger.Apply(todo!, changes, nowMs);
            if (merge.Error is not null || (isNew && todo!.Title.Length == 0))
            {
                results.Add(new(m.OpId, MutationStatus.Rejected, Error: merge.Error ?? "title é obrigatório.",
                    Current: isNew ? null : TodoDto.From(todo!)));
                continue;
            }

            var deletedNow = m.DeletedAt is { } at && TodoMerger.Delete(todo!, at, nowMs);
            if (!isNew && !merge.Changed && !deletedNow)
            {
                results.Add(new(m.OpId, MutationStatus.Noop, merge.RejectedFields));
                continue;
            }

            todo!.Version++;
            todo.UpdatedAt = nowMs;
            todo.ServerSeq = ++seq;
            if (isNew) db.Todos.Add(todo);
            touched[todo.Id] = todo;

            var type = deletedNow ? "todo.deleted" : isNew ? "todo.created" : "todo.updated";
            AddOutboxEvent(todo, type, now, subscriptions);
            anyEvent = true;

            results.Add(new(m.OpId, MutationStatus.Applied, merge.RejectedFields));
        }

        await db.SaveChangesAsync(ct);
        await db.Users.Where(u => u.Id == userId)
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.SyncSeq, seq), ct);
        await tx.CommitAsync(ct);

        if (anyEvent) signal.Notify();
        return results;
    }

    private void AddOutboxEvent(Todo todo, string type, DateTimeOffset now, List<Guid> subscriptions)
    {
        var eventId = Guid.NewGuid();
        var payload = JsonSerializer.Serialize(new
        {
            eventId,
            type,
            occurredAt = now,
            ownerId = todo.UserId,
            aggregate = new { type = "todo", id = todo.Id, version = todo.Version },
            data = TodoDto.From(todo),
        }, EventJson);

        var ev = new OutboxEvent
        {
            Id = eventId,
            UserId = todo.UserId,
            AggregateId = todo.Id,
            AggregateVersion = todo.Version,
            Type = type,
            Payload = payload,
            OccurredAt = now,
        };
        db.OutboxEvents.Add(ev);

        foreach (var subscriptionId in subscriptions)
        {
            db.OutboxDeliveries.Add(new OutboxDelivery
            {
                Event = ev,
                SubscriptionId = subscriptionId,
                AggregateId = todo.Id,
                NextAttemptAt = now,
            });
        }
    }

    private async Task<(List<TodoDto> Changes, long Cursor, bool HasMore)> PullAsync(Guid userId, long cursor, CancellationToken ct)
    {
        var rows = await db.Todos.AsNoTracking()
            .Where(t => t.UserId == userId && t.ServerSeq > cursor)
            .OrderBy(t => t.ServerSeq)
            .Take(PullPageSize + 1)
            .ToListAsync(ct);

        var hasMore = rows.Count > PullPageSize;
        if (hasMore) rows.RemoveAt(rows.Count - 1);
        var next = rows.Count > 0 ? rows[^1].ServerSeq : cursor;
        return (rows.Select(TodoDto.From).ToList(), next, hasMore);
    }
}
