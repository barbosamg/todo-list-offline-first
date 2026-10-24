using System.Text.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TodoOffline.Api.Infrastructure;
using TodoOffline.Api.Outbox;
using static TodoOffline.Tests.Integration.TestDevice;

namespace TodoOffline.Tests.Integration;

[Collection(PostgresCollection.Name)]
public sealed class OutboxTests : IDisposable
{
    private readonly ApiFactory _factory;

    public OutboxTests(PostgresFixture pg) => _factory = new ApiFactory(pg.ConnectionString);

    public void Dispose() => _factory.Dispose();

    private async Task<List<OutboxEvent>> EventsOf(Guid aggregateId)
    {
        using var scope = _factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().OutboxEvents.AsNoTracking()
            .Where(e => e.AggregateId == aggregateId).OrderBy(e => e.Sequence).ToListAsync();
    }

    [Fact]
    public async Task Changes_write_domain_events_in_order_with_incrementing_versions()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();

        await phone.SyncAsync(Op(id, ("title", "Nova", 10)));
        await phone.SyncAsync(Op(id, ("status", "completed", 20)));
        await phone.SyncAsync(Delete(id, 30));

        var events = await EventsOf(id);
        events.Select(e => (e.Type, e.AggregateVersion)).Should().Equal(
            ("todo.created", 1L), ("todo.updated", 2L), ("todo.deleted", 3L));
    }

    [Fact]
    public async Task Rejected_or_noop_mutations_emit_no_events()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        var op = Op(id, ("title", "Uma vez só", 10));

        await phone.SyncAsync(op);
        await phone.SyncAsync(op);                                        // replay → noop
        await phone.SyncAsync(Op(id, ("title", "perdeu", 5)));            // LWW perdeu → noop
        await phone.SyncAsync(Op(Guid.NewGuid(), ("description", "x", 1))); // inválida → rejected

        (await EventsOf(id)).Should().HaveCount(1);
    }

    [Fact]
    public async Task Dispatcher_delivers_signed_events_and_marks_them_delivered()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "Entregar", 10)));

        await _factory.CreateDispatcher().DispatchOnceAsync(CancellationToken.None);

        var call = _factory.Sender.For(id).Should().ContainSingle().Subject;
        call.Type.Should().Be("todo.created");
        call.Signature.Should().Be(WebhookSender.Sign("test-secret", call.Body));
        using var doc = JsonDocument.Parse(call.Body);
        doc.RootElement.GetProperty("data").GetProperty("title").GetString().Should().Be("Entregar");

        // nada novo para entregar
        await _factory.CreateDispatcher().DispatchOnceAsync(CancellationToken.None);
        _factory.Sender.For(id).Should().HaveCount(1);
    }

    [Fact]
    public async Task Failed_delivery_is_retried_with_backoff_and_keeps_per_aggregate_order()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        var other = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "v1", 10)));
        await phone.SyncAsync(Op(id, ("title", "v2", 20)));
        await phone.SyncAsync(Op(other, ("title", "outra tarefa", 10)));

        var failures = 0;
        _factory.Sender.Fail = c => c.AggregateId == id && c.Version == 1 && failures++ < 2; // v1 falha 2x
        var dispatcher = _factory.CreateDispatcher();

        await dispatcher.DispatchOnceAsync(CancellationToken.None);
        // v1 falhou → v2 NÃO pode ser entregue antes; a outra tarefa não é afetada
        _factory.Sender.For(id).Select(c => c.Version).Should().Equal(1);
        _factory.Sender.For(other).Should().HaveCount(1);

        // ainda dentro do backoff: nada é reenviado
        await dispatcher.DispatchOnceAsync(CancellationToken.None);
        _factory.Sender.For(id).Should().HaveCount(1);

        // passa o backoff (10s * 2^0 ±20%) → 2ª tentativa falha; passa o próximo (20s) → sucesso, e só então v2
        _factory.Clock.Advance(TimeSpan.FromSeconds(13));
        await dispatcher.DispatchOnceAsync(CancellationToken.None);
        _factory.Clock.Advance(TimeSpan.FromSeconds(30));
        while (await dispatcher.DispatchOnceAsync(CancellationToken.None) > 0) { }

        _factory.Sender.For(id).Select(c => (c.Version, c.Attempt)).Should().Equal((1, 1), (1, 2), (1, 3), (2, 1));
    }

    [Fact]
    public async Task Poison_event_goes_to_dead_letter_after_max_attempts_and_unblocks_the_next_one()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "veneno", 10)));
        await phone.SyncAsync(Op(id, ("title", "depois", 20)));

        _factory.Sender.Fail = c => c.AggregateId == id && c.Version == 1; // v1 nunca passa
        var dispatcher = _factory.CreateDispatcher(new WebhookOptions { MaxAttempts = 3, BaseBackoffSeconds = 1, MaxBackoffSeconds = 1 });

        for (var i = 0; i < 6; i++)
        {
            await dispatcher.DispatchOnceAsync(CancellationToken.None);
            _factory.Clock.Advance(TimeSpan.FromSeconds(5));
        }

        _factory.Sender.For(id).Where(c => c.Version == 1).Should().HaveCount(3);
        _factory.Sender.For(id).Should().Contain(c => c.Version == 2, "v1 virou dead-letter e liberou a fila do agregado");

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        (await db.OutboxDeliveries.AsNoTracking().CountAsync(d => d.AggregateId == id && d.Status == DeliveryStatus.Dead)).Should().Be(1);
    }
}
