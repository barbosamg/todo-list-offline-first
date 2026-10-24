using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using TodoOffline.Api.Domain;
using TodoOffline.Api.Infrastructure;

namespace TodoOffline.Api.Features.Sync;

public static class SyncEndpoints
{
    public static Guid UserId(this ClaimsPrincipal user) =>
        Guid.Parse(user.FindFirstValue("sub") ?? throw new InvalidOperationException("Token sem 'sub'."));

    public static void MapSync(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api").RequireAuthorization().WithTags("Sync");

        // Push da fila offline + pull do que mudou desde o cursor, numa única ida e volta.
        api.MapPost("/sync", async (SyncRequest req, ClaimsPrincipal user, SyncService sync, CancellationToken ct) =>
        {
            if (req.Mutations?.Count > SyncService.MaxMutationsPerRequest)
                return Results.BadRequest(new { error = $"No máximo {SyncService.MaxMutationsPerRequest} operações por requisição." });
            if (req.Cursor < 0) return Results.BadRequest(new { error = "cursor inválido." });
            return Results.Ok(await sync.SyncAsync(user.UserId(), req, ct));
        });

        // Leitura online (útil para depuração/integrações): mesma ordenação padrão do app.
        api.MapGet("/todos", async (ClaimsPrincipal user, AppDbContext db, string? q, string? status, string? priority, string? category, CancellationToken ct) =>
        {
            var uid = user.UserId();
            var rows = await db.Todos.AsNoTracking()
                .Where(t => t.UserId == uid && t.DeletedAt == null).ToListAsync(ct);

            IEnumerable<Todo> filtered = rows;
            if (!string.IsNullOrWhiteSpace(status)) filtered = filtered.Where(t => TodoMerger.StatusToWire(t.Status) == status);
            if (!string.IsNullOrWhiteSpace(priority)) filtered = filtered.Where(t => TodoMerger.PriorityToWire(t.Priority) == priority);
            if (!string.IsNullOrWhiteSpace(category)) filtered = filtered.Where(t => t.Category == category);
            if (!string.IsNullOrWhiteSpace(q))
                filtered = filtered.Where(t =>
                    t.Title.Contains(q, StringComparison.OrdinalIgnoreCase) ||
                    (t.Description?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false));

            return Results.Ok(TodoOrdering.Default(filtered).Select(TodoDto.From));
        });
    }
}
