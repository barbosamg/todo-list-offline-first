using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using TodoOffline.Api.Infrastructure;

namespace TodoOffline.Api.Outbox;

/// <summary>
/// Publica o outbox para os consumidores externos (at-least-once).
///  • Garantia: o evento já está commitado junto com a mudança; só é marcado "Delivered" após 2xx.
///    Se o processo cair entre o 2xx e o UPDATE, o evento é reenviado → duplicata possível; o
///    consumidor deduplica por X-Event-Id (idempotência).
///  • Ordem: por assinatura e por agregado (tarefa). Uma entrega só é elegível se não houver outra
///    anterior pendente do mesmo agregado/assinatura. Agregados diferentes seguem em paralelo e um
///    consumidor lento/fora do ar não bloqueia os demais (cada assinatura tem as suas entregas).
///  • Falha: backoff exponencial com jitter; após MaxAttempts → Dead (dead-letter).
///  • Escala horizontal: claim com FOR UPDATE SKIP LOCKED + lease (LockedUntil).
/// </summary>
public sealed class OutboxDispatcher(
    IServiceScopeFactory scopes,
    OutboxSignal signal,
    IOptions<WebhookOptions> options,
    TimeProvider clock,
    ILogger<OutboxDispatcher> logger) : BackgroundService
{
    private readonly WebhookOptions _o = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var processed = 0;
            try { processed = await DispatchOnceAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception e) { logger.LogError(e, "Falha no ciclo do dispatcher de outbox."); }

            if (processed == 0)
                await signal.WaitAsync(TimeSpan.FromMilliseconds(_o.PollIntervalMs), stoppingToken);
        }
    }

    /// <summary>Executa um ciclo (claim → entrega → registro). Retorna quantas entregas foram tentadas.</summary>
    public async Task<int> DispatchOnceAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var sender = scope.ServiceProvider.GetRequiredService<IWebhookSender>();

        var ids = await ClaimAsync(db, ct);
        if (ids.Count == 0) return 0;

        var deliveries = await db.OutboxDeliveries
            .Include(d => d.Event).Include(d => d.Subscription)
            .Where(d => ids.Contains(d.Id))
            .OrderBy(d => d.Id)
            .ToListAsync(ct);

        // Assinaturas em paralelo (isolamento entre consumidores); dentro de cada uma, em ordem.
        var outcomes = await Task.WhenAll(deliveries.GroupBy(d => d.SubscriptionId).Select(async group =>
        {
            var list = new List<(OutboxDelivery Delivery, bool Ok, string? Error)>();
            foreach (var d in group)
            {
                // O lote só contém a "cabeça" de cada agregado, então a falha de um não ultrapassa a ordem de outro.
                var (ok, error) = await sender.SendAsync(d.Subscription, d.Event, d.Attempts + 1, ct);
                list.Add((d, ok, error));
            }
            return list;
        }));

        var now = clock.GetUtcNow();
        var attempted = new HashSet<long>();
        foreach (var (d, ok, error) in outcomes.SelectMany(o => o))
        {
            attempted.Add(d.Id);
            d.Attempts++;
            d.LockedUntil = null;
            if (ok)
            {
                d.Status = DeliveryStatus.Delivered;
                d.DeliveredAt = now;
                d.LastError = null;
            }
            else
            {
                d.LastError = error;
                if (d.Attempts >= _o.MaxAttempts)
                {
                    d.Status = DeliveryStatus.Dead;
                    logger.LogError("Entrega {Delivery} para {Subscriber} movida para dead-letter: {Error}", d.Id, d.Subscription.Name, error);
                }
                else
                {
                    d.NextAttemptAt = now + Backoff(d.Attempts);
                    logger.LogWarning("Falha ao entregar {Delivery} a {Subscriber} (tentativa {Attempt}): {Error}. Próxima em {Delay}.",
                        d.Id, d.Subscription.Name, d.Attempts, error, d.NextAttemptAt - now);
                }
            }
        }

        await db.SaveChangesAsync(ct);
        return attempted.Count;
    }

    public TimeSpan Backoff(int attempts)
    {
        var seconds = Math.Min(_o.BaseBackoffSeconds * Math.Pow(2, attempts - 1), _o.MaxBackoffSeconds);
        var jitter = 0.8 + Random.Shared.NextDouble() * 0.4; // ±20%
        return TimeSpan.FromSeconds(seconds * jitter);
    }

    private async Task<List<long>> ClaimAsync(AppDbContext db, CancellationToken ct)
    {
        const string sql = """
            UPDATE "OutboxDeliveries" SET "LockedUntil" = @lease
            WHERE "Id" IN (
                SELECT d."Id" FROM "OutboxDeliveries" d
                WHERE d."Status" = 'Pending'
                  AND d."NextAttemptAt" <= @now
                  AND (d."LockedUntil" IS NULL OR d."LockedUntil" < @now)
                  AND NOT EXISTS (
                      SELECT 1 FROM "OutboxDeliveries" p
                      WHERE p."SubscriptionId" = d."SubscriptionId"
                        AND p."AggregateId" = d."AggregateId"
                        AND p."Status" = 'Pending'
                        AND p."Id" < d."Id")
                ORDER BY d."Id"
                LIMIT @batch
                FOR UPDATE SKIP LOCKED)
            RETURNING "Id"
            """;

        var now = clock.GetUtcNow();
        var conn = db.Database.GetDbConnection();
        await db.Database.OpenConnectionAsync(ct);
        try
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = sql;
            AddParam(cmd, "now", now.UtcDateTime);
            AddParam(cmd, "lease", now.UtcDateTime.AddSeconds(_o.LeaseSeconds));
            AddParam(cmd, "batch", _o.BatchSize);

            var ids = new List<long>();
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) ids.Add(reader.GetInt64(0));
            return ids;
        }
        finally { await db.Database.CloseConnectionAsync(); }
    }

    private static void AddParam(System.Data.Common.DbCommand cmd, string name, object value)
    {
        var p = cmd.CreateParameter();
        p.ParameterName = name;
        p.Value = value;
        cmd.Parameters.Add(p);
    }
}
