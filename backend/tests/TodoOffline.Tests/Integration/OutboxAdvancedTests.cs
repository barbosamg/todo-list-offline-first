using System.Text.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TodoOffline.Api.Infrastructure;
using TodoOffline.Api.Outbox;
using static TodoOffline.Tests.Integration.TestDevice;

namespace TodoOffline.Tests.Integration;

[Collection(PostgresCollection.Name)]
public sealed class OutboxAdvancedTests : IDisposable
{
    private readonly ApiFactory _factory;

    public OutboxAdvancedTests(PostgresFixture pg) => _factory = new ApiFactory(pg.ConnectionString);

    public void Dispose() => _factory.Dispose();

    private async Task<T> WithDb<T>(Func<AppDbContext, Task<T>> action)
    {
        using var scope = _factory.Services.CreateScope();
        return await action(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    private async Task AddSubscription(string name, bool enabled = true)
    {
        await WithDb(async db =>
        {
            db.WebhookSubscriptions.Add(new WebhookSubscription
            {
                Id = Guid.NewGuid(), Name = name, Url = $"http://{name}.test/hook", Secret = $"secret-{name}", Enabled = enabled,
            });
            await db.SaveChangesAsync();
            return 0;
        });
    }

    private async Task DrainAsync(OutboxDispatcher dispatcher)
    {
        for (var i = 0; i < 50 && await dispatcher.DispatchOnceAsync(CancellationToken.None) > 0; i++) { }
    }

    [Fact]
    public async Task Each_event_is_fanned_out_to_every_active_consumer_and_signed_with_its_own_secret()
    {
        await AddSubscription("beta");
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "Para todos", 10)));

        await DrainAsync(_factory.CreateDispatcher());

        var calls = _factory.Sender.For(id);
        calls.Select(c => c.Subscriber).Should().BeEquivalentTo("test-consumer", "beta");
        calls.Single(c => c.Subscriber == "beta").Signature.Should().Be(WebhookSender.Sign("secret-beta", calls[0].Body));
        calls.Single(c => c.Subscriber == "test-consumer").Signature.Should().Be(WebhookSender.Sign("test-secret", calls[0].Body));
    }

    [Fact]
    public async Task A_failing_consumer_does_not_block_the_healthy_one()
    {
        await AddSubscription("lento");
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "isolamento", 10)));
        await phone.SyncAsync(Op(id, ("title", "isolamento 2", 20)));
        _factory.Sender.Fail = c => c.Subscriber == "lento";

        await DrainAsync(_factory.CreateDispatcher());

        var healthy = _factory.Sender.For(id).Where(c => c.Subscriber == "test-consumer").Select(c => c.Version);
        healthy.Should().Equal(1L, 2L);
        _factory.Sender.For(id).Where(c => c.Subscriber == "lento").Select(c => c.Version)
            .Should().Equal(new[] { 1L }, "o consumidor lento fica preso na v1 (ordem preservada), sem atrasar o outro");
    }

    [Fact]
    public async Task Disabled_consumers_receive_nothing()
    {
        await AddSubscription("desligado", enabled: false);
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "ninguém ouve", 10)));

        await DrainAsync(_factory.CreateDispatcher());

        _factory.Sender.For(id).Should().OnlyContain(c => c.Subscriber == "test-consumer");
        (await WithDb(db => db.OutboxDeliveries.CountAsync(d => d.AggregateId == id && d.Subscription.Name == "desligado")))
            .Should().Be(0);
    }

    [Fact]
    public async Task Many_updates_of_one_task_are_delivered_strictly_in_version_order()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "v1", 10)));
        for (var i = 2; i <= 8; i++) await phone.SyncAsync(Op(id, ("title", $"v{i}", 10L * i)));

        await DrainAsync(_factory.CreateDispatcher(new WebhookOptions { BatchSize = 3, MaxAttempts = 4, BaseBackoffSeconds = 1 }));

        _factory.Sender.For(id).Select(c => c.Version).Should().Equal(1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L);
    }

    [Fact]
    public async Task Different_tasks_are_all_delivered_even_with_a_tiny_batch()
    {
        var phone = await RegisterAsync(_factory);
        var ids = Enumerable.Range(0, 7).Select(_ => Guid.NewGuid()).ToArray();
        await phone.SyncAsync(ids.Select((id, i) => Op(id, ("title", $"t{i}", 10))).ToArray());

        await DrainAsync(_factory.CreateDispatcher(new WebhookOptions { BatchSize = 2 }));

        ids.Should().OnlyContain(id => _factory.Sender.For(id).Count == 1);
    }

    [Fact]
    public async Task Event_payload_has_the_documented_contract()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "Contrato URGENTE", 10), ("priority", "high", 10), ("category", "Campo", 10)));

        await DrainAsync(_factory.CreateDispatcher());

        var call = _factory.Sender.For(id).Single();
        using var doc = JsonDocument.Parse(call.Body);
        var root = doc.RootElement;
        root.GetProperty("eventId").GetGuid().Should().Be(call.EventId);
        root.GetProperty("type").GetString().Should().Be("todo.created");
        root.GetProperty("ownerId").GetGuid().Should().Be(phone.UserId);
        root.GetProperty("occurredAt").GetDateTimeOffset().Should().BeCloseTo(DateTimeOffset.UtcNow, TimeSpan.FromMinutes(1));
        root.GetProperty("aggregate").GetProperty("type").GetString().Should().Be("todo");
        root.GetProperty("aggregate").GetProperty("id").GetGuid().Should().Be(id);
        root.GetProperty("aggregate").GetProperty("version").GetInt64().Should().Be(1);
        var data = root.GetProperty("data");
        data.GetProperty("title").GetString().Should().Be("Contrato URGENTE");
        data.GetProperty("priority").GetString().Should().Be("high");
        data.GetProperty("category").GetString().Should().Be("Campo");
        data.GetProperty("isUrgent").GetBoolean().Should().BeTrue();
        data.GetProperty("deletedAt").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public async Task Delete_event_carries_the_tombstone_snapshot()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "Última", 10)));
        await phone.SyncAsync(Delete(id, 20));

        await DrainAsync(_factory.CreateDispatcher());

        var del = _factory.Sender.For(id).Single(c => c.Type == "todo.deleted");
        using var doc = JsonDocument.Parse(del.Body);
        doc.RootElement.GetProperty("data").GetProperty("deletedAt").GetInt64().Should().Be(20);
        doc.RootElement.GetProperty("aggregate").GetProperty("version").GetInt64().Should().Be(2);
    }

    [Fact]
    public async Task Events_of_each_user_carry_their_own_owner_id()
    {
        var alice = await RegisterAsync(_factory);
        var bob = await RegisterAsync(_factory);
        var a = Guid.NewGuid(); var b = Guid.NewGuid();
        await alice.SyncAsync(Op(a, ("title", "alice", 10)));
        await bob.SyncAsync(Op(b, ("title", "bob", 10)));

        await DrainAsync(_factory.CreateDispatcher());

        JsonDocument.Parse(_factory.Sender.For(a).Single().Body).RootElement.GetProperty("ownerId").GetGuid().Should().Be(alice.UserId);
        JsonDocument.Parse(_factory.Sender.For(b).Single().Body).RootElement.GetProperty("ownerId").GetGuid().Should().Be(bob.UserId);
    }

    [Fact]
    public async Task Failed_attempts_are_recorded_with_error_and_next_attempt_time()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "falha registrada", 10)));
        _factory.Sender.Fail = _ => true;
        var dispatcher = _factory.CreateDispatcher(new WebhookOptions { MaxAttempts = 5, BaseBackoffSeconds = 10, MaxBackoffSeconds = 300 });

        await dispatcher.DispatchOnceAsync(CancellationToken.None);

        var d = await WithDb(db => db.OutboxDeliveries.AsNoTracking().SingleAsync(x => x.AggregateId == id));
        d.Status.Should().Be(DeliveryStatus.Pending);
        d.Attempts.Should().Be(1);
        d.LastError.Should().Be("HTTP 503");
        d.NextAttemptAt.Should().BeAfter(_factory.Clock.GetUtcNow().AddSeconds(7));
        d.LockedUntil.Should().BeNull("o lease é liberado depois da tentativa");
    }

    [Fact]
    public async Task Successful_delivery_clears_the_error_and_stamps_the_time()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "recupera", 10)));
        var failOnce = true;
        _factory.Sender.Fail = _ => failOnce && !(failOnce = false);
        var dispatcher = _factory.CreateDispatcher();

        await dispatcher.DispatchOnceAsync(CancellationToken.None);   // falha
        _factory.Clock.Advance(TimeSpan.FromMinutes(1));
        await dispatcher.DispatchOnceAsync(CancellationToken.None);   // sucesso

        var d = await WithDb(db => db.OutboxDeliveries.AsNoTracking().SingleAsync(x => x.AggregateId == id));
        (d.Status, d.Attempts, d.LastError).Should().Be((DeliveryStatus.Delivered, 2, null));
        d.DeliveredAt.Should().NotBeNull();
    }

    [Fact]
    public async Task A_delivery_claimed_by_another_instance_is_skipped_until_its_lease_expires()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "lease", 10)));
        await WithDb(async db =>
        {
            var d = await db.OutboxDeliveries.SingleAsync(x => x.AggregateId == id);
            d.LockedUntil = _factory.Clock.GetUtcNow().AddSeconds(30); // "outra instância" está entregando
            await db.SaveChangesAsync();
            return 0;
        });
        var dispatcher = _factory.CreateDispatcher();

        await dispatcher.DispatchOnceAsync(CancellationToken.None);
        _factory.Sender.For(id).Should().BeEmpty("o lease ainda vale");

        _factory.Clock.Advance(TimeSpan.FromSeconds(31)); // a outra instância morreu: o lease expira
        await dispatcher.DispatchOnceAsync(CancellationToken.None);
        _factory.Sender.For(id).Should().HaveCount(1);
    }

    [Fact]
    public async Task Dead_deliveries_are_never_retried()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "morta", 10)));
        _factory.Sender.Fail = _ => true;
        var dispatcher = _factory.CreateDispatcher(new WebhookOptions { MaxAttempts = 2, BaseBackoffSeconds = 1, MaxBackoffSeconds = 1 });

        for (var i = 0; i < 6; i++) { await dispatcher.DispatchOnceAsync(CancellationToken.None); _factory.Clock.Advance(TimeSpan.FromSeconds(10)); }

        _factory.Sender.For(id).Should().HaveCount(2);
        (await WithDb(db => db.OutboxDeliveries.AsNoTracking().SingleAsync(x => x.AggregateId == id))).Status.Should().Be(DeliveryStatus.Dead);
    }

    [Fact]
    public async Task Sync_signals_the_dispatcher_after_commit()
    {
        var signal = _factory.Services.GetRequiredService<OutboxSignal>();
        var phone = await RegisterAsync(_factory);
        var wait = signal.WaitAsync(TimeSpan.FromSeconds(10), CancellationToken.None);

        await phone.SyncAsync(Op(Guid.NewGuid(), ("title", "acorda", 10)));

        (await Task.WhenAny(wait, Task.Delay(TimeSpan.FromSeconds(5)))).Should().BeSameAs(wait);
    }

    [Fact]
    public async Task Rejected_mutations_leave_no_task_and_no_event_behind()
    {
        var phone = await RegisterAsync(_factory);
        var good = Guid.NewGuid(); var bad = Guid.NewGuid();

        await phone.SyncAsync(Op(good, ("title", "boa", 10)), Op(bad, ("priority", "high", 10))); // a segunda é inválida

        (await WithDb(db => db.OutboxEvents.CountAsync(e => e.AggregateId == good))).Should().Be(1);
        (await WithDb(db => db.OutboxEvents.CountAsync(e => e.AggregateId == bad))).Should().Be(0);
        (await WithDb(db => db.Todos.CountAsync(t => t.Id == bad))).Should().Be(0);
    }
}
