using FluentAssertions;
using TodoOffline.Api.Domain;

namespace TodoOffline.Tests.Domain;

public class TodoOrderingTests
{
    private static Todo T(string title, bool urgent = false, Priority p = Priority.Medium, TodoStatus s = TodoStatus.Pending,
        string? due = null, long created = 1) => new()
    {
        Id = Guid.NewGuid(), Title = title, IsUrgent = urgent, Priority = p, Status = s, CreatedAt = created,
        DueDate = due is null ? null : DateOnly.Parse(due),
    };

    [Fact]
    public void Urgent_tasks_come_first_even_if_completed_or_low_priority()
    {
        var list = new[]
        {
            T("alta", p: Priority.High, due: "2026-01-01"),
            T("urgente concluída", urgent: true, s: TodoStatus.Completed, p: Priority.Low),
            T("média"),
        };

        TodoOrdering.Default(list).First().Title.Should().Be("urgente concluída");
    }

    [Fact]
    public void Urgent_tasks_are_ordered_among_themselves_by_the_default_criteria()
    {
        var list = new[]
        {
            T("U baixa", urgent: true, p: Priority.Low),
            T("U alta vence depois", urgent: true, p: Priority.High, due: "2026-12-01"),
            T("U alta vence antes", urgent: true, p: Priority.High, due: "2026-06-01"),
            T("comum alta", p: Priority.High),
        };

        TodoOrdering.Default(list).Select(t => t.Title).Should().Equal(
            "U alta vence antes", "U alta vence depois", "U baixa", "comum alta");
    }

    [Fact]
    public void Default_order_is_pending_then_priority_then_due_date_then_newest()
    {
        var list = new[]
        {
            T("concluída alta", p: Priority.High, s: TodoStatus.Completed),
            T("pendente baixa", p: Priority.Low),
            T("pendente média sem data", created: 5),
            T("pendente média com data", due: "2026-03-01", created: 1),
            T("pendente média sem data (mais antiga)", created: 2),
        };

        TodoOrdering.Default(list).Select(t => t.Title).Should().Equal(
            "pendente média com data", "pendente média sem data", "pendente média sem data (mais antiga)",
            "pendente baixa", "concluída alta");
    }
}
