using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using static TodoOffline.Tests.Integration.TestDevice;

namespace TodoOffline.Tests.Integration;

[Collection(PostgresCollection.Name)]
public sealed class SyncTests : IDisposable
{
    private readonly ApiFactory _factory;

    public SyncTests(PostgresFixture pg) => _factory = new ApiFactory(pg.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Sync_requires_authentication()
    {
        var res = await _factory.CreateClient().PostAsJsonAsync("/api/sync", new { cursor = 0 });
        res.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Offline_created_task_is_stored_and_pulled_by_another_device()
    {
        var phone = await RegisterAsync(_factory);
        var desktop = phone.Clone(_factory);
        var id = Guid.NewGuid();

        var push = await phone.SyncAsync(Op(id, ("title", "Tarefa criada offline", 100), ("priority", "high", 100)));
        push.Results.Single().Status.Should().Be("applied");

        var pull = await desktop.SyncAsync();
        var todo = pull.Changes.Should().ContainSingle().Subject;
        (todo.Id, todo.Title, todo.Priority, todo.Status).Should().Be((id, "Tarefa criada offline", "high", "pending"));
    }

    [Fact]
    public async Task Users_only_see_their_own_tasks_and_cannot_take_over_ids()
    {
        var alice = await RegisterAsync(_factory);
        var bob = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await alice.SyncAsync(Op(id, ("title", "segredo da Alice", 10)));

        (await bob.SyncAsync()).Changes.Should().BeEmpty();

        var hijack = await bob.SyncAsync(Op(id, ("title", "sequestrada", 99)));
        hijack.Results.Single().Status.Should().Be("rejected");
        (await alice.Clone(_factory).SyncAsync()).Changes.Single().Title.Should().Be("segredo da Alice");
    }

    [Fact]
    public async Task Concurrent_edits_to_different_fields_are_merged()
    {
        var phone = await RegisterAsync(_factory);
        var desktop = phone.Clone(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "Reunião", 10)));
        await desktop.SyncAsync(); // os dois dispositivos partem do mesmo estado

        // celular (offline) muda a descrição; desktop muda a prioridade; ambos sincronizam depois
        await desktop.SyncAsync(Op(id, ("priority", "high", 30)));
        await phone.SyncAsync(Op(id, ("description", "levar notebook", 20)));

        var merged = (await desktop.SyncAsync()).Changes.Single();
        (merged.Priority, merged.Description, merged.Title).Should().Be(("high", "levar notebook", "Reunião"));
    }

    [Fact]
    public async Task Concurrent_edits_to_the_same_field_keep_the_latest_edit_and_report_the_loss()
    {
        var phone = await RegisterAsync(_factory);
        var desktop = phone.Clone(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "Original", 10)));
        await desktop.SyncAsync();

        await desktop.SyncAsync(Op(id, ("title", "Editado no desktop", 50)));
        // o celular editou ANTES (t=40), mas só reconectou agora: não deve sobrescrever
        var late = await phone.SyncAsync(Op(id, ("title", "Editado no celular", 40)));

        late.Results.Single().RejectedFields.Should().Contain("title");
        late.Changes.Single().Title.Should().Be("Editado no desktop", "o celular recebe o vencedor na mesma resposta");
    }

    [Fact]
    public async Task Replaying_the_same_batch_is_idempotent()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        var op = Op(id, ("title", "Reenviada", 10));

        var first = await phone.SyncAsync(op);
        var replay = await phone.SyncAsync(op); // timeout de rede: o app reenviou o mesmo lote

        first.Results.Single().Status.Should().Be("applied");
        replay.Results.Single().Status.Should().Be("noop");
        (await phone.Http.GetFromJsonAsync<List<TodoOffline.Api.Features.Sync.TodoDto>>("/api/todos"))!
            .Should().ContainSingle(t => t.Id == id).Which.Version.Should().Be(1);
    }

    [Fact]
    public async Task Delete_propagates_as_tombstone_and_wins_over_later_edits()
    {
        var phone = await RegisterAsync(_factory);
        var desktop = phone.Clone(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "Vai ser removida", 10)));
        await desktop.SyncAsync();

        await phone.SyncAsync(Delete(id, 20));
        // o desktop, sem saber da remoção, edita e sincroniza: a edição é descartada e ele recebe o tombstone
        var res = await desktop.SyncAsync(Op(id, ("title", "edição depois da remoção", 30)));

        res.Results.Single().Status.Should().Be("noop");
        var tombstone = res.Changes.Should().ContainSingle().Subject;
        (tombstone.DeletedAt, tombstone.Title).Should().Be((20L, "Vai ser removida"));
        (await phone.Http.GetFromJsonAsync<List<TodoOffline.Api.Features.Sync.TodoDto>>("/api/todos"))!
            .Should().NotContain(t => t.Id == id);
    }

    [Fact]
    public async Task Invalid_mutation_is_rejected_without_blocking_the_rest_of_the_batch()
    {
        var phone = await RegisterAsync(_factory);
        var bad = Guid.NewGuid();
        var good = Guid.NewGuid();

        var res = await phone.SyncAsync(
            Op(bad, ("description", "sem título", 10)),
            Op(good, ("title", "válida", 10)));

        res.Results.Select(r => r.Status).Should().Equal("rejected", "applied");
        res.Changes.Should().ContainSingle(t => t.Id == good);
    }

    [Fact]
    public async Task Urgent_flag_is_derived_on_the_server_and_ordering_puts_urgent_first()
    {
        var phone = await RegisterAsync(_factory);
        await phone.SyncAsync(
            Op(Guid.NewGuid(), ("title", "Comum alta", 10), ("priority", "high", 10)),
            Op(Guid.NewGuid(), ("title", "Qualquer coisa", 11), ("description", "isso é URGENTE", 11), ("priority", "low", 11)));

        var list = (await phone.Http.GetFromJsonAsync<List<TodoOffline.Api.Features.Sync.TodoDto>>("/api/todos"))!;

        list.Select(t => t.Title).Should().Equal("Qualquer coisa", "Comum alta");
        list[0].IsUrgent.Should().BeTrue();
    }

    [Fact]
    public async Task Pull_is_paginated_and_resumes_from_the_cursor()
    {
        var phone = await RegisterAsync(_factory);
        for (var batch = 0; batch < 2; batch++)
            await phone.SyncAsync(Enumerable.Range(0, 130)
                .Select(i => Op(Guid.NewGuid(), ("title", $"t{batch}-{i}", 10))).ToArray());

        var fresh = phone.Clone(_factory);
        var total = 0;
        bool more;
        do
        {
            var page = await fresh.SyncAsync();
            total += page.Changes.Count;
            more = page.HasMore;
        } while (more);

        total.Should().Be(260);
    }
}
