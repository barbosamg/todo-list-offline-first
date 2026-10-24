using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using TodoOffline.Api.Features.Sync;
using TodoOffline.Api.Infrastructure;
using static TodoOffline.Tests.Integration.TestDevice;

namespace TodoOffline.Tests.Integration;

[Collection(PostgresCollection.Name)]
public sealed class SyncAdvancedTests : IDisposable
{
    private readonly ApiFactory _factory;

    public SyncAdvancedTests(PostgresFixture pg) => _factory = new ApiFactory(pg.ConnectionString);

    public void Dispose() => _factory.Dispose();

    private long NowMs => _factory.Clock.GetUtcNow().ToUnixTimeMilliseconds();

    // ---------- limites e validação do contrato ----------

    [Fact]
    public async Task More_than_200_mutations_in_one_request_is_rejected()
    {
        var phone = await RegisterAsync(_factory);
        var mutations = Enumerable.Range(0, 201).Select(i => Op(Guid.NewGuid(), ("title", $"t{i}", 10))).ToArray();

        var res = await phone.Http.PostAsJsonAsync("/api/sync", new { cursor = 0, mutations });

        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Exactly_200_mutations_are_accepted()
    {
        var phone = await RegisterAsync(_factory);
        var mutations = Enumerable.Range(0, 200).Select(i => Op(Guid.NewGuid(), ("title", $"t{i}", 10))).ToArray();

        var res = await phone.SyncAsync(mutations);

        res.Results.Should().OnlyContain(r => r.Status == "applied").And.HaveCount(200);
    }

    [Fact]
    public async Task Negative_cursor_is_rejected()
    {
        var phone = await RegisterAsync(_factory);
        var res = await phone.Http.PostAsJsonAsync("/api/sync", new { cursor = -1 });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Empty_sync_returns_nothing_and_keeps_the_cursor()
    {
        var phone = await RegisterAsync(_factory);

        var res = await phone.SyncAsync();

        res.Results.Should().BeEmpty();
        res.Changes.Should().BeEmpty();
        res.Cursor.Should().Be(0);
        res.HasMore.Should().BeFalse();
    }

    [Fact]
    public async Task Request_without_a_body_is_a_client_error_not_a_server_error()
    {
        var phone = await RegisterAsync(_factory);
        var res = await phone.Http.PostAsync("/api/sync", new StringContent("", System.Text.Encoding.UTF8, "application/json"));
        ((int)res.StatusCode).Should().BeInRange(400, 499);
    }

    [Theory]
    [InlineData("title", "")]
    [InlineData("title", "   ")]
    [InlineData("priority", "urgent")]
    [InlineData("status", "archived")]
    [InlineData("dueDate", "2026-13-45")]
    [InlineData("dueDate", "amanhã")]
    [InlineData("campoInexistente", "x")]
    public async Task Invalid_values_are_rejected_with_an_error_message(string field, string value)
    {
        var phone = await RegisterAsync(_factory);

        var fields = field == "title"
            ? new (string, object?, long)[] { (field, value, 10) }
            : [("title", "ok", 10), (field, value, 10)];

        var res = await phone.SyncAsync(Op(Guid.NewGuid(), fields));

        var r = res.Results.Single();
        r.Status.Should().Be("rejected");
        r.Error.Should().NotBeNullOrWhiteSpace();
        res.Changes.Should().BeEmpty("a mutação inválida não pode criar nada");
    }

    [Fact]
    public async Task Title_longer_than_200_chars_is_rejected_but_exactly_200_is_accepted()
    {
        var phone = await RegisterAsync(_factory);

        var tooLong = await phone.SyncAsync(Op(Guid.NewGuid(), ("title", new string('x', 201), 10)));
        var exact = await phone.SyncAsync(Op(Guid.NewGuid(), ("title", new string('x', 200), 10)));

        tooLong.Results.Single().Status.Should().Be("rejected");
        exact.Results.Single().Status.Should().Be("applied");
    }

    [Fact]
    public async Task Description_limit_is_4000_chars()
    {
        var phone = await RegisterAsync(_factory);
        var ok = await phone.SyncAsync(Op(Guid.NewGuid(), ("title", "a", 10), ("description", new string('d', 4000), 10)));
        var bad = await phone.SyncAsync(Op(Guid.NewGuid(), ("title", "a", 10), ("description", new string('d', 4001), 10)));

        ok.Results.Single().Status.Should().Be("applied");
        bad.Results.Single().Status.Should().Be("rejected");
    }

    [Fact]
    public async Task Create_without_title_is_rejected()
    {
        var phone = await RegisterAsync(_factory);
        var res = await phone.SyncAsync(Op(Guid.NewGuid(), ("priority", "high", 10)));
        res.Results.Single().Status.Should().Be("rejected");
    }

    [Fact]
    public async Task Rejected_update_of_an_existing_task_returns_its_current_server_state()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "Original", 10), ("priority", "high", 10)));

        var res = await phone.SyncAsync(Op(id, ("priority", "invalida", 20)));

        var r = res.Results.Single();
        r.Status.Should().Be("rejected");
        r.Current.Should().NotBeNull();
        (r.Current!.Title, r.Current.Priority).Should().Be(("Original", "high"));
    }

    // ---------- semântica das operações ----------

    [Fact]
    public async Task Delete_of_an_unknown_id_is_a_noop()
    {
        var phone = await RegisterAsync(_factory);
        var res = await phone.SyncAsync(Delete(Guid.NewGuid(), 10));
        res.Results.Single().Status.Should().Be("noop");
        res.Changes.Should().BeEmpty();
    }

    [Fact]
    public async Task Another_user_cannot_delete_or_edit_a_task_they_do_not_own()
    {
        var alice = await RegisterAsync(_factory);
        var bob = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await alice.SyncAsync(Op(id, ("title", "da Alice", 10)));

        var del = await bob.SyncAsync(Delete(id, 20));
        var edit = await bob.SyncAsync(Op(id, ("title", "hack", 30)));

        del.Results.Single().Status.Should().Be("rejected");
        edit.Results.Single().Status.Should().Be("rejected");
        var still = (await alice.Clone(_factory).SyncAsync()).Changes.Single();
        (still.Title, still.DeletedAt).Should().Be(("da Alice", null));
    }

    [Fact]
    public async Task Create_then_update_in_the_same_request_yields_version_2()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();

        var res = await phone.SyncAsync(
            Op(id, ("title", "v1", 10)),
            Op(id, ("title", "v2", 20), ("priority", "high", 20)));

        res.Results.Select(r => r.Status).Should().Equal("applied", "applied");
        var todo = res.Changes.Single(t => t.Id == id);
        (todo.Title, todo.Priority, todo.Version).Should().Be(("v2", "high", 2L));
    }

    [Fact]
    public async Task Create_then_delete_in_the_same_request_leaves_only_a_tombstone()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();

        var res = await phone.SyncAsync(Op(id, ("title", "efêmera", 10)), Delete(id, 20));

        res.Results.Select(r => r.Status).Should().Equal("applied", "applied");
        res.Changes.Single().DeletedAt.Should().NotBeNull();
    }

    [Fact]
    public async Task One_mutation_can_edit_and_delete_at_once()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "antes", 10)));

        var res = await phone.SyncAsync(new
        {
            opId = Guid.NewGuid(), id, createdAt = (long?)null,
            changes = new Dictionary<string, object> { ["title"] = new { value = "depois", at = 20L } },
            deletedAt = 25L,
        });

        res.Results.Single().Status.Should().Be("applied");
        var t = res.Changes.Single();
        (t.Title, t.DeletedAt).Should().Be(("depois", 25L));
    }

    [Fact]
    public async Task Setting_a_field_to_null_clears_it_and_updates_the_urgent_flag()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        var first = await phone.SyncAsync(Op(id, ("title", "Rotina", 10), ("description", "isso é urgente", 10)));
        first.Changes.Single().IsUrgent.Should().BeTrue();

        var res = await phone.SyncAsync(Op(id, ("description", null, 20)));

        var t = res.Changes.Single();
        (t.Description, t.IsUrgent).Should().Be((null, false));
    }

    [Fact]
    public async Task Due_date_can_be_set_and_cleared()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        var set = await phone.SyncAsync(Op(id, ("title", "Prazo", 10), ("dueDate", "2026-12-31", 10)));
        set.Changes.Single().DueDate.Should().Be("2026-12-31");

        var cleared = await phone.SyncAsync(Op(id, ("dueDate", null, 20)));
        cleared.Changes.Single().DueDate.Should().BeNull();
    }

    [Fact]
    public async Task Text_is_trimmed_and_empty_optional_text_becomes_null()
    {
        var phone = await RegisterAsync(_factory);

        var res = await phone.SyncAsync(Op(Guid.NewGuid(), ("title", "  espaçada  ", 10), ("description", "   ", 10), ("category", " Casa ", 10)));

        var t = res.Changes.Single();
        (t.Title, t.Description, t.Category).Should().Be(("espaçada", null, "Casa"));
    }

    [Fact]
    public async Task Unicode_and_emoji_survive_the_round_trip()
    {
        var phone = await RegisterAsync(_factory);
        const string title = "Revisão — çãõ ñ 日本語 🚧 <b>não é html</b> \"aspas\" 'simples'";

        var res = await phone.SyncAsync(Op(Guid.NewGuid(), ("title", title, 10)));

        res.Changes.Single().Title.Should().Be(title);
    }

    [Fact]
    public async Task Client_supplied_created_at_is_kept_but_clamped_to_server_time()
    {
        var phone = await RegisterAsync(_factory);
        var past = NowMs - 86_400_000;
        var future = NowMs + 86_400_000;

        var res = await phone.SyncAsync(
            new { opId = Guid.NewGuid(), id = Guid.NewGuid(), createdAt = (long?)past, changes = new { title = new { value = "passado", at = past } } },
            new { opId = Guid.NewGuid(), id = Guid.NewGuid(), createdAt = (long?)future, changes = new { title = new { value = "futuro", at = future } } });

        var byTitle = res.Changes.ToDictionary(t => t.Title);
        byTitle["passado"].CreatedAt.Should().Be(past, "a ordem 'mais recentes primeiro' precisa sobreviver à sincronização");
        byTitle["futuro"].CreatedAt.Should().BeLessThanOrEqualTo(NowMs);
        byTitle["futuro"].FieldTimes["title"].Should().BeLessThanOrEqualTo(NowMs, "relógio adiantado não pode vencer para sempre");
    }

    [Fact]
    public async Task A_device_with_a_fast_clock_cannot_lock_a_field_forever()
    {
        var phone = await RegisterAsync(_factory);
        var desktop = phone.Clone(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "celular adiantado", NowMs + 365L * 86_400_000)));
        _factory.Clock.Advance(TimeSpan.FromMinutes(5));

        await desktop.SyncAsync(Op(id, ("title", "desktop depois", NowMs)));

        (await phone.SyncAsync()).Changes.Single().Title.Should().Be("desktop depois");
    }

    // ---------- cursor / ordem / concorrência ----------

    [Fact]
    public async Task Server_sequence_is_strictly_increasing_and_the_cursor_is_the_highest_one()
    {
        var phone = await RegisterAsync(_factory);
        var ids = Enumerable.Range(0, 5).Select(_ => Guid.NewGuid()).ToArray();

        var res = await phone.SyncAsync(ids.Select((id, i) => Op(id, ("title", $"t{i}", 10))).ToArray());

        var seqs = res.Changes.Select(c => c.Seq).ToList();
        seqs.Should().BeInAscendingOrder().And.OnlyHaveUniqueItems();
        res.Cursor.Should().Be(seqs.Max());
    }

    [Fact]
    public async Task Pull_after_the_cursor_returns_only_newer_changes()
    {
        var phone = await RegisterAsync(_factory);
        var a = Guid.NewGuid(); var b = Guid.NewGuid();
        await phone.SyncAsync(Op(a, ("title", "a", 10)));
        var cursorAfterA = phone.Cursor;

        await phone.Clone(_factory).SyncAsync(Op(b, ("title", "b", 20)));
        var res = await phone.SyncAsync();

        res.Changes.Select(t => t.Id).Should().Equal(b);
        phone.Cursor.Should().BeGreaterThan(cursorAfterA);
    }

    [Fact]
    public async Task An_edit_moves_the_task_to_a_new_sequence_so_other_devices_see_it()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        var created = await phone.SyncAsync(Op(id, ("title", "x", 10)));
        var seq1 = created.Changes.Single().Seq;

        var edited = await phone.SyncAsync(Op(id, ("title", "y", 20)));

        edited.Changes.Single().Seq.Should().BeGreaterThan(seq1);
    }

    [Fact]
    public async Task Pull_page_boundary_exactly_200_has_no_more_and_201_has_one_more()
    {
        var phone = await RegisterAsync(_factory);
        await phone.SyncAsync(Enumerable.Range(0, 200).Select(i => Op(Guid.NewGuid(), ("title", $"t{i}", 10))).ToArray());

        var exactly = await phone.Clone(_factory).SyncAsync();
        exactly.Changes.Should().HaveCount(200);
        exactly.HasMore.Should().BeFalse();

        await phone.SyncAsync(Op(Guid.NewGuid(), ("title", "201", 10)));
        var reader = phone.Clone(_factory);
        var page1 = await reader.SyncAsync();
        var page2 = await reader.SyncAsync();
        (page1.Changes.Count, page1.HasMore, page2.Changes.Count, page2.HasMore).Should().Be((200, true, 1, false));
    }

    [Fact]
    public async Task Concurrent_pushes_from_many_devices_lose_nothing_and_never_repeat_a_sequence()
    {
        var owner = await RegisterAsync(_factory);
        var ids = Enumerable.Range(0, 30).Select(_ => Guid.NewGuid()).ToArray();

        await Task.WhenAll(ids.Select(id => Task.Run(async () =>
        {
            var device = owner.Clone(_factory);
            var res = await device.SyncAsync(Op(id, ("title", $"concorrente {id:N}", 10)));
            res.Results.Single().Status.Should().Be("applied");
        })));

        var all = new List<TodoDto>();
        var reader = owner.Clone(_factory);
        do { var page = await reader.SyncAsync(); all.AddRange(page.Changes); if (!page.HasMore) break; } while (true);

        all.Select(t => t.Id).Should().BeEquivalentTo(ids);
        all.Select(t => t.Seq).Should().OnlyHaveUniqueItems();
        all.Max(t => t.Seq).Should().Be(30, "os contadores por usuário são contíguos: nenhuma mudança é pulada");
    }

    [Fact]
    public async Task Concurrent_edits_of_the_same_field_converge_to_the_latest_edit()
    {
        var owner = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await owner.SyncAsync(Op(id, ("title", "base", 1)));

        // 25 dispositivos disputam o título, cada um com um instante distinto; o maior (t=1025) deve vencer
        await Task.WhenAll(Enumerable.Range(0, 25).Reverse().Select(i => Task.Run(async () =>
            await owner.Clone(_factory).SyncAsync(Op(id, ("title", $"edição {i}", 1000 + i + 1)))
        )));

        var final = (await owner.Clone(_factory).SyncAsync()).Changes.Single();
        final.Title.Should().Be("edição 24");
        final.FieldTimes["title"].Should().Be(1025);
    }

    [Fact]
    public async Task Users_syncing_in_parallel_do_not_interfere()
    {
        var users = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => RegisterAsync(_factory)));

        await Task.WhenAll(users.Select((u, i) => Task.Run(async () =>
        {
            for (var n = 0; n < 5; n++) await u.SyncAsync(Op(Guid.NewGuid(), ("title", $"u{i}-{n}", 10)));
        })));

        foreach (var (u, i) in users.Select((u, i) => (u, i)))
        {
            var titles = (await u.Clone(_factory).SyncAsync()).Changes.Select(t => t.Title).ToList();
            titles.Should().HaveCount(5).And.OnlyContain(t => t.StartsWith($"u{i}-"));
        }
    }

    [Fact]
    public async Task User_sequence_counter_matches_the_number_of_changes()
    {
        var phone = await RegisterAsync(_factory);
        var id = Guid.NewGuid();
        await phone.SyncAsync(Op(id, ("title", "1", 10)), Op(id, ("title", "2", 20)), Op(Guid.NewGuid(), ("title", "3", 10)));
        await phone.SyncAsync(Delete(id, 30));

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.Users.Single(u => u.Id == phone.UserId).SyncSeq.Should().Be(4);
    }
}
