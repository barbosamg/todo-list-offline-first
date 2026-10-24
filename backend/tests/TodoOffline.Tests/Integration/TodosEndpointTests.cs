using System.Net.Http.Json;
using FluentAssertions;
using TodoOffline.Api.Features.Sync;
using static TodoOffline.Tests.Integration.TestDevice;

namespace TodoOffline.Tests.Integration;

[Collection(PostgresCollection.Name)]
public sealed class TodosEndpointTests : IDisposable
{
    private readonly ApiFactory _factory;

    public TodosEndpointTests(PostgresFixture pg) => _factory = new ApiFactory(pg.ConnectionString);

    public void Dispose() => _factory.Dispose();

    private static Task<List<TodoDto>?> List(TestDevice d, string query = "") =>
        d.Http.GetFromJsonAsync<List<TodoDto>>("/api/todos" + query);

    private static async Task<TestDevice> Seeded(ApiFactory f)
    {
        var d = await RegisterAsync(f);
        await d.SyncAsync(
            Op(Guid.NewGuid(), ("title", "Comprar leite", 10), ("priority", "low", 10), ("category", "Casa", 10)),
            Op(Guid.NewGuid(), ("title", "Relatório mensal", 10), ("description", "enviar ao gerente", 10), ("priority", "high", 10), ("category", "Trabalho", 10)),
            Op(Guid.NewGuid(), ("title", "Pagar conta", 10), ("status", "completed", 10), ("category", "Casa", 10)),
            Op(Guid.NewGuid(), ("title", "Ligar para o cliente URGENTE", 10), ("priority", "medium", 10)));
        return d;
    }

    [Fact]
    public async Task Lists_only_my_non_deleted_tasks()
    {
        var d = await Seeded(_factory);
        var other = await Seeded(_factory);
        var toDelete = Guid.NewGuid();
        await d.SyncAsync(Op(toDelete, ("title", "vai embora", 10)), Delete(toDelete, 20));

        var list = (await List(d))!;

        list.Should().HaveCount(4).And.NotContain(t => t.Id == toDelete);
        (await List(other))!.Should().HaveCount(4);
        list.Select(t => t.Id).Should().NotIntersectWith((await List(other))!.Select(t => t.Id));
    }

    [Fact]
    public async Task Default_order_puts_urgent_first_then_pending_by_priority()
    {
        var d = await Seeded(_factory);

        var titles = (await List(d))!.Select(t => t.Title).ToList();

        titles.Should().Equal("Ligar para o cliente URGENTE", "Relatório mensal", "Comprar leite", "Pagar conta");
    }

    [Theory]
    [InlineData("?status=completed", new[] { "Pagar conta" })]
    [InlineData("?status=pending", new[] { "Ligar para o cliente URGENTE", "Relatório mensal", "Comprar leite" })]
    [InlineData("?priority=high", new[] { "Relatório mensal" })]
    [InlineData("?priority=low", new[] { "Comprar leite" })]
    [InlineData("?category=Casa", new[] { "Comprar leite", "Pagar conta" })]
    [InlineData("?category=Trabalho", new[] { "Relatório mensal" })]
    [InlineData("?q=LEITE", new[] { "Comprar leite" })]
    [InlineData("?q=gerente", new[] { "Relatório mensal" })]
    [InlineData("?q=urgente", new[] { "Ligar para o cliente URGENTE" })]
    [InlineData("?q=inexistente", new string[0])]
    [InlineData("?status=pending&category=Casa", new[] { "Comprar leite" })]
    public async Task Filters_combine_and_keep_the_default_order(string query, string[] expected)
    {
        var d = await Seeded(_factory);
        (await List(d, query))!.Select(t => t.Title).Should().Equal(expected);
    }

    [Fact]
    public async Task Urgent_tasks_stay_on_top_even_when_filtering()
    {
        var d = await Seeded(_factory);
        var titles = (await List(d, "?status=pending"))!.Select(t => t.Title).ToList();
        titles.First().Should().Be("Ligar para o cliente URGENTE");
    }

    [Fact]
    public async Task Returns_the_wire_format_expected_by_the_client()
    {
        var d = await RegisterAsync(_factory);
        await d.SyncAsync(Op(Guid.NewGuid(), ("title", "Formato", 10), ("priority", "high", 10), ("dueDate", "2026-05-01", 10)));

        var t = (await List(d))!.Single();

        (t.Priority, t.Status, t.DueDate, t.Version, t.IsUrgent).Should().Be(("high", "pending", "2026-05-01", 1L, false));
        t.FieldTimes.Should().ContainKeys("title", "priority", "dueDate");
    }
}
