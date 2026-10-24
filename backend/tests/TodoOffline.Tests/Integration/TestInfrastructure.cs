using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Testcontainers.PostgreSql;
using TodoOffline.Api.Features.Auth;
using TodoOffline.Api.Features.Sync;
using TodoOffline.Api.Outbox;

namespace TodoOffline.Tests.Integration;

/// <summary>Um PostgreSQL real (Testcontainers) por execução: o sync usa locks/jsonb/SKIP LOCKED, então InMemory não serve.</summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:17-alpine").Build();
    public string ConnectionString => _pg.GetConnectionString();
    public Task InitializeAsync() => _pg.StartAsync();
    public Task DisposeAsync() => _pg.DisposeAsync().AsTask();
}

[CollectionDefinition(Name)]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>
{
    public const string Name = "postgres";
}

public sealed class FakeWebhookSender : IWebhookSender
{
    public record Call(Guid EventId, string Type, Guid AggregateId, long Version, int Attempt, string Signature, string Body);

    private readonly object _gate = new();
    public List<Call> Calls { get; } = [];

    /// <summary>Decide se a tentativa falha. Padrão: sempre sucesso.</summary>
    public Func<Call, bool> Fail { get; set; } = _ => false;

    public Task<(bool Ok, string? Error)> SendAsync(WebhookSubscription s, OutboxEvent ev, int attempt, CancellationToken ct)
    {
        var call = new Call(ev.Id, ev.Type, ev.AggregateId, ev.AggregateVersion, attempt, WebhookSender.Sign(s.Secret, ev.Payload), ev.Payload);
        lock (_gate) Calls.Add(call);
        return Task.FromResult(Fail(call) ? (false, "HTTP 503") : (true, (string?)null));
    }

    public List<Call> For(Guid aggregateId)
    {
        lock (_gate) return Calls.Where(c => c.AggregateId == aggregateId).ToList();
    }
}

public sealed class ApiFactory(string containerConnectionString) : WebApplicationFactory<Program>
{
    // Um banco por factory (a migration cria o banco): testes não enxergam a fila de outbox uns dos outros.
    private readonly string connectionString = new Npgsql.NpgsqlConnectionStringBuilder(containerConnectionString)
    {
        Database = $"todo_test_{Guid.NewGuid():N}",
    }.ConnectionString;

    // Parte da hora real: a validação do JWT usa o relógio do sistema, então tokens emitidos no "passado" já nasceriam expirados.
    public FakeTimeProvider Clock { get; } = new(DateTimeOffset.UtcNow);
    public FakeWebhookSender Sender { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("ConnectionStrings:Default", connectionString);
        builder.UseSetting("Seed:Enabled", "false");
        builder.UseSetting("Webhooks:Subscribers:0:Name", "test-consumer");
        builder.UseSetting("Webhooks:Subscribers:0:Url", "http://consumer.test/webhooks");
        builder.UseSetting("Webhooks:Subscribers:0:Secret", "test-secret");

        builder.ConfigureServices(services =>
        {
            // O dispatcher é conduzido manualmente nos testes (determinismo), não em background.
            services.RemoveAll<IHostedService>();
            services.RemoveAll<IWebhookSender>();
            services.AddSingleton<IWebhookSender>(Sender);
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);
        });
    }

    public OutboxDispatcher CreateDispatcher(WebhookOptions? options = null) => new(
        Services.GetRequiredService<IServiceScopeFactory>(),
        Services.GetRequiredService<OutboxSignal>(),
        Options.Create(options ?? new WebhookOptions { MaxAttempts = 4, BaseBackoffSeconds = 10, MaxBackoffSeconds = 300 }),
        Clock,
        NullLogger<OutboxDispatcher>.Instance);
}

internal static class ServiceCollectionExtensions
{
    public static void RemoveAll<T>(this IServiceCollection services)
    {
        foreach (var d in services.Where(d => d.ServiceType == typeof(T)).ToList()) services.Remove(d);
    }
}

/// <summary>Cliente HTTP autenticado de um usuário (equivale a um "dispositivo" no teste).</summary>
public sealed class TestDevice
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;
    public Guid UserId { get; private set; }
    public long Cursor { get; set; }

    private TestDevice(HttpClient http) => _http = http;

    public static async Task<TestDevice> RegisterAsync(ApiFactory factory, string? email = null)
    {
        var device = new TestDevice(factory.CreateClient());
        var res = await device._http.PostAsJsonAsync("/api/auth/register",
            new { name = "Teste", email = email ?? $"{Guid.NewGuid():N}@test.dev", password = "secret123" });
        res.EnsureSuccessStatusCode();
        var auth = (await res.Content.ReadFromJsonAsync<AuthResponse>(Json))!;
        device._http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", auth.Token);
        device.UserId = auth.User.Id;
        return device;
    }

    /// <summary>Outro dispositivo do mesmo usuário (mesmo token, cursor próprio).</summary>
    public TestDevice Clone(ApiFactory factory)
    {
        var c = new TestDevice(factory.CreateClient()) { UserId = UserId };
        c._http.DefaultRequestHeaders.Authorization = _http.DefaultRequestHeaders.Authorization;
        return c;
    }

    public HttpClient Http => _http;

    public async Task<SyncResponse> SyncAsync(params object[] mutations)
    {
        var res = await _http.PostAsJsonAsync("/api/sync", new { cursor = Cursor, mutations }, Json);
        res.EnsureSuccessStatusCode();
        var body = (await res.Content.ReadFromJsonAsync<SyncResponse>(Json))!;
        Cursor = body.Cursor;
        return body;
    }

    /// <summary>Monta uma operação: id + campos (nome → valor, instante da edição).</summary>
    public static object Op(Guid id, params (string Field, object? Value, long At)[] fields) => new
    {
        opId = Guid.NewGuid(),
        id,
        createdAt = (long?)null,
        changes = fields.ToDictionary(f => f.Field, f => new { value = f.Value, at = f.At }),
    };

    public static object Delete(Guid id, long at) => new { opId = Guid.NewGuid(), id, deletedAt = at };
}
