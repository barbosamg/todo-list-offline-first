using FluentAssertions;
using TodoOffline.Api.Domain;

namespace TodoOffline.Tests.Domain;

public class TodoOrderingExtraTests
{
    private static Todo T(string title, bool urgent = false, Priority p = Priority.Medium, TodoStatus s = TodoStatus.Pending,
        string? due = null, long created = 1, Guid? id = null) => new()
    {
        Id = id ?? Guid.NewGuid(), Title = title, IsUrgent = urgent, Priority = p, Status = s, CreatedAt = created,
        DueDate = due is null ? null : DateOnly.Parse(due),
    };

    private static string[] Order(params Todo[] todos) => TodoOrdering.Default(todos).Select(t => t.Title).ToArray();

    [Fact]
    public void Id_breaks_ties_so_the_order_is_deterministic()
    {
        var a = T("a", id: Guid.Parse("00000000-0000-0000-0000-000000000001"));
        var b = T("b", id: Guid.Parse("00000000-0000-0000-0000-000000000002"));
        Order(b, a).Should().Equal("a", "b");
        Order(a, b).Should().Equal("a", "b");
    }

    [Fact]
    public void Same_input_in_any_order_gives_the_same_output()
    {
        var items = Enumerable.Range(0, 30).Select(i => T($"t{i}", urgent: i % 5 == 0, p: (Priority)(i % 3),
            s: i % 4 == 0 ? TodoStatus.Completed : TodoStatus.Pending, due: i % 3 == 0 ? $"2026-0{1 + i % 9}-1{i % 9}" : null, created: i)).ToArray();
        var expected = Order(items);

        var rnd = new Random(7);
        for (var k = 0; k < 20; k++) Order(items.OrderBy(_ => rnd.Next()).ToArray()).Should().Equal(expected);
    }

    [Fact]
    public void Earlier_due_date_comes_first_and_no_due_date_comes_last()
    {
        Order(T("sem data"), T("tarde", due: "2027-01-01"), T("cedo", due: "2026-01-01"))
            .Should().Equal("cedo", "tarde", "sem data");
    }

    [Fact]
    public void Newer_tasks_come_first_when_everything_else_is_equal()
    {
        Order(T("velha", created: 1), T("nova", created: 9), T("meio", created: 5)).Should().Equal("nova", "meio", "velha");
    }

    [Fact]
    public void Priority_beats_due_date_within_the_same_status()
    {
        Order(T("baixa urgente-prazo", p: Priority.Low, due: "2026-01-01"), T("alta sem prazo", p: Priority.High))
            .Should().Equal("alta sem prazo", "baixa urgente-prazo");
    }

    [Fact]
    public void Pending_beats_priority()
    {
        Order(T("concluída alta", p: Priority.High, s: TodoStatus.Completed), T("pendente baixa", p: Priority.Low))
            .Should().Equal("pendente baixa", "concluída alta");
    }

    [Fact]
    public void Urgent_beats_everything_else()
    {
        Order(
            T("alta com prazo", p: Priority.High, due: "2026-01-01", created: 99),
            T("urgente concluída baixa", urgent: true, p: Priority.Low, s: TodoStatus.Completed, created: 1))
            .Should().Equal("urgente concluída baixa", "alta com prazo");
    }

    [Fact]
    public void Empty_and_single_lists_are_fine()
    {
        Order().Should().BeEmpty();
        Order(T("só")).Should().Equal("só");
    }
}
