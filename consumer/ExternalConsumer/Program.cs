using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Consumidor externo SIMULADO. Só recebe (somente leitura): registra o que chega, mostra num painel e
// demonstra os pontos que um consumidor real precisa tratar: assinatura, idempotência e versões antigas.

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<ConsumerState>();
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
var app = builder.Build();

var secret = app.Configuration["Webhook:Secret"] ?? "dev-shared-secret";

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapPost("/webhooks/todos", async (HttpRequest request, ConsumerState state, ILogger<Program> log) =>
{
    using var reader = new StreamReader(request.Body, Encoding.UTF8);
    var body = await reader.ReadToEndAsync();

    var eventId = request.Headers["X-Event-Id"].ToString();
    var type = request.Headers["X-Event-Type"].ToString();
    _ = int.TryParse(request.Headers["X-Delivery-Attempt"], out var attempt);

    // 1) autenticidade: HMAC-SHA256 do corpo exato com o segredo compartilhado
    var expected = "sha256=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body)));
    var given = request.Headers["X-Signature"].ToString();
    if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(given)))
    {
        state.Log(new(DateTimeOffset.UtcNow, eventId, type, null, 0, attempt, "assinatura-invalida", null));
        log.LogWarning("Assinatura inválida para {EventId}", eventId);
        return Results.Unauthorized();
    }

    // 2) falha injetada (para demonstrar retry/backoff no produtor)
    if (state.TryConsumeFailure())
    {
        state.Log(new(DateTimeOffset.UtcNow, eventId, type, null, 0, attempt, "falha-injetada", null));
        log.LogWarning("Falha injetada ao receber {EventId} (tentativa {Attempt})", eventId, attempt);
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }

    using var doc = JsonDocument.Parse(body);
    var root = doc.RootElement;
    var aggregateId = root.GetProperty("aggregate").GetProperty("id").GetGuid();
    var version = root.GetProperty("aggregate").GetProperty("version").GetInt64();
    var data = root.GetProperty("data");
    var title = data.TryGetProperty("title", out var t) ? t.GetString() : null;

    // 3) idempotência: at-least-once => o mesmo evento pode chegar mais de uma vez
    if (!state.SeenEvents.TryAdd(eventId, true))
    {
        state.Log(new(DateTimeOffset.UtcNow, eventId, type, aggregateId, version, attempt, "duplicado-ignorado", title));
        return Results.Ok(new { status = "duplicate" });
    }

    // 4) versão: ignora estados mais antigos que o já projetado (reordenação/replays)
    if (state.Projection.TryGetValue(aggregateId, out var current) && current.Version >= version)
    {
        state.Log(new(DateTimeOffset.UtcNow, eventId, type, aggregateId, version, attempt, "versao-antiga-ignorada", title));
        return Results.Ok(new { status = "stale" });
    }

    state.Projection[aggregateId] = new Projected(aggregateId, version, type == "todo.deleted", data.Clone());
    state.Log(new(DateTimeOffset.UtcNow, eventId, type, aggregateId, version, attempt, "aplicado", title));
    log.LogInformation("{Type} {Aggregate} v{Version} \"{Title}\" (tentativa {Attempt})", type, aggregateId, version, title, attempt);
    return Results.Ok(new { status = "applied" });
});

app.MapGet("/api/events", (ConsumerState s) => s.Snapshot());
app.MapGet("/api/state", (ConsumerState s) => new
{
    failuresPending = s.FailuresPending,
    todos = s.Projection.Values.Where(p => !p.Deleted).Select(p => new { p.Id, p.Version, data = p.Data }),
});
app.MapPost("/admin/failures", (int count, ConsumerState s) => { s.FailuresPending = Math.Max(0, count); return Results.Ok(new { failuresPending = s.FailuresPending }); });
app.MapPost("/admin/reset", (ConsumerState s) => { s.Reset(); return Results.Ok(); });

app.Run();

public sealed record Received(DateTimeOffset At, string EventId, string Type, Guid? AggregateId, long Version, int Attempt, string Outcome, string? Title);
public sealed record Projected(Guid Id, long Version, bool Deleted, JsonElement Data);

public sealed class ConsumerState
{
    private readonly object _gate = new();
    private int _failures;

    public ConcurrentDictionary<string, bool> SeenEvents { get; } = new();
    public ConcurrentDictionary<Guid, Projected> Projection { get; } = new();
    public List<Received> Events { get; } = [];

    public int FailuresPending { get => Volatile.Read(ref _failures); set => Volatile.Write(ref _failures, value); }

    public bool TryConsumeFailure()
    {
        lock (_gate)
        {
            if (_failures <= 0) return false;
            _failures--;
            return true;
        }
    }

    /// <summary>Últimos eventos, do mais recente para o mais antigo.</summary>
    public Received[] Snapshot()
    {
        lock (_gate) return Events.AsEnumerable().Reverse().Take(200).ToArray();
    }

    public void Log(Received e)
    {
        lock (_gate)
        {
            Events.Add(e);
            if (Events.Count > 500) Events.RemoveAt(0);
        }
    }

    public void Reset()
    {
        lock (_gate) { Events.Clear(); _failures = 0; }
        SeenEvents.Clear();
        Projection.Clear();
    }
}
