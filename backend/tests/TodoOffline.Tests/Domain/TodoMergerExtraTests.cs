using System.Text.Json;
using FluentAssertions;
using TodoOffline.Api.Domain;
using TodoOffline.Api.Features.Sync;

namespace TodoOffline.Tests.Domain;

public class TodoMergerExtraTests
{
    private const long Now = 5_000_000;

    private static FieldChange Text(string? v, long at) => new(JsonSerializer.SerializeToElement(v), at);
    private static FieldChange Raw(object? v, long at) => new(JsonSerializer.SerializeToElement(v), at);
    private static Dictionary<string, FieldChange> C(params (string F, FieldChange Ch)[] items) => items.ToDictionary(i => i.F, i => i.Ch);
    private static Todo NewTodo() => new() { Id = Guid.NewGuid(), UserId = Guid.NewGuid() };

    [Fact]
    public void Defaults_of_a_new_task_are_medium_priority_and_pending()
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 1))), Now);
        (t.Priority, t.Status, t.Description, t.DueDate, t.Category).Should().Be((Priority.Medium, TodoStatus.Pending, null, null, null));
    }

    [Theory]
    [InlineData("low", Priority.Low)]
    [InlineData("medium", Priority.Medium)]
    [InlineData("high", Priority.High)]
    public void Priority_wire_values_map_both_ways(string wire, Priority expected)
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 1)), ("priority", Text(wire, 2))), Now);
        t.Priority.Should().Be(expected);
        TodoMerger.PriorityToWire(expected).Should().Be(wire);
        TodoMerger.PriorityFromWire(wire).Should().Be(expected);
    }

    [Theory]
    [InlineData("pending", TodoStatus.Pending)]
    [InlineData("completed", TodoStatus.Completed)]
    public void Status_wire_values_map_both_ways(string wire, TodoStatus expected)
    {
        TodoMerger.StatusFromWire(wire).Should().Be(expected);
        TodoMerger.StatusToWire(expected).Should().Be(wire);
    }

    [Fact]
    public void Completing_and_reopening_are_ordinary_field_edits()
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 1))), Now);
        TodoMerger.Apply(t, C(("status", Text("completed", 10))), Now);
        t.Status.Should().Be(TodoStatus.Completed);
        TodoMerger.Apply(t, C(("status", Text("pending", 20))), Now);
        t.Status.Should().Be(TodoStatus.Pending);
    }

    [Fact]
    public void Old_complete_does_not_override_a_newer_reopen()
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 1)), ("status", Text("pending", 30))), Now);
        TodoMerger.Apply(t, C(("status", Text("completed", 20))), Now).RejectedFields.Should().Contain("status");
        t.Status.Should().Be(TodoStatus.Pending);
    }

    [Theory]
    [InlineData("2026-02-29")] // 2026 não é bissexto
    [InlineData("2026-1-5")]
    [InlineData("05/01/2026")]
    [InlineData("2026-01-05T10:00:00")]
    public void Date_must_be_strict_yyyy_MM_dd(string value)
    {
        TodoMerger.Apply(NewTodo(), C(("title", Text("x", 1)), ("dueDate", Text(value, 2))), Now).Error.Should().NotBeNull();
    }

    [Fact]
    public void Valid_leap_day_is_accepted()
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 1)), ("dueDate", Text("2028-02-29", 2))), Now).Error.Should().BeNull();
        t.DueDate.Should().Be(new DateOnly(2028, 2, 29));
    }

    [Fact]
    public void Empty_string_clears_the_due_date()
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 1)), ("dueDate", Text("2026-05-05", 2))), Now);
        TodoMerger.Apply(t, C(("dueDate", Text("", 3))), Now);
        t.DueDate.Should().BeNull();
    }

    [Fact]
    public void Non_string_values_are_rejected_with_a_clear_error()
    {
        var r1 = TodoMerger.Apply(NewTodo(), C(("title", Raw(123, 1))), Now);
        var r2 = TodoMerger.Apply(NewTodo(), C(("title", Text("x", 1)), ("description", Raw(true, 2))), Now);
        var r3 = TodoMerger.Apply(NewTodo(), C(("title", Text("x", 1)), ("priority", Raw(2, 2))), Now);

        r1.Error.Should().Contain("title");
        r2.Error.Should().Contain("description");
        r3.Error.Should().Contain("priority");
    }

    [Fact]
    public void Title_null_is_rejected_but_description_null_is_allowed()
    {
        TodoMerger.Apply(NewTodo(), C(("title", Text(null, 1))), Now).Error.Should().Contain("obrigatório");
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 1)), ("description", Text("d", 2))), Now);
        TodoMerger.Apply(t, C(("description", Text(null, 3))), Now).Error.Should().BeNull();
        t.Description.Should().BeNull();
    }

    [Fact]
    public void Category_is_trimmed_limited_to_50_and_empty_means_none()
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 1)), ("category", Text("  Obra  ", 2))), Now);
        t.Category.Should().Be("Obra");
        TodoMerger.Apply(t, C(("category", Text(new string('c', 51), 3))), Now).Error.Should().NotBeNull();
        TodoMerger.Apply(t, C(("category", Text("  ", 4))), Now);
        t.Category.Should().BeNull();
    }

    [Fact]
    public void Equal_value_with_a_newer_timestamp_is_not_a_change_but_records_the_timestamp()
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("igual", 10))), Now);
        var r = TodoMerger.Apply(t, C(("title", Text("igual", 99))), Now);
        r.Changed.Should().BeFalse();
        r.RejectedFields.Should().BeEmpty();
        t.FieldTimes["title"].Should().Be(99, "o instante mais recente é registrado mesmo sem mudar o valor");
    }

    [Fact]
    public void Timestamps_below_one_are_raised_to_one_so_they_beat_a_never_edited_field()
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 0))), Now);
        t.Title.Should().Be("x");
        t.FieldTimes["title"].Should().Be(1);
    }

    [Fact]
    public void Merge_result_does_not_depend_on_the_order_across_many_random_permutations()
    {
        var rnd = new Random(42);
        var edits = Enumerable.Range(0, 12).Select(i => C(
            ("title", Text($"t{rnd.Next(5)}", rnd.Next(1, 8))),
            ("priority", Text(new[] { "low", "medium", "high" }[rnd.Next(3)], rnd.Next(1, 8))),
            ("category", Text($"c{rnd.Next(3)}", rnd.Next(1, 8))))).ToList();

        string Run(IEnumerable<Dictionary<string, FieldChange>> order)
        {
            var t = NewTodo();
            TodoMerger.Apply(t, C(("title", Text("base", 1))), Now);
            foreach (var e in order) TodoMerger.Apply(t, e, Now);
            return $"{t.Title}|{t.Priority}|{t.Category}";
        }

        var baseline = Run(edits);
        for (var i = 0; i < 100; i++)
            Run(edits.OrderBy(_ => rnd.Next()).Concat(edits.Take(3))).Should().Be(baseline);
    }

    [Fact]
    public void Delete_uses_the_given_instant_clamped_to_server_time()
    {
        var past = NewTodo(); var future = NewTodo();
        TodoMerger.Delete(past, 100, Now);
        TodoMerger.Delete(future, Now * 10, Now);
        past.DeletedAt.Should().Be(100);
        future.DeletedAt.Should().Be(Now);
    }

    [Fact]
    public void Edits_to_a_deleted_task_report_every_field_as_rejected()
    {
        var t = NewTodo();
        TodoMerger.Apply(t, C(("title", Text("x", 1))), Now);
        TodoMerger.Delete(t, 5, Now);

        var r = TodoMerger.Apply(t, C(("title", Text("novo", 50)), ("priority", Text("high", 50))), Now);

        r.Changed.Should().BeFalse();
        r.RejectedFields.Should().BeEquivalentTo("title", "priority");
    }
}

public class TodoDtoTests
{
    [Fact]
    public void Maps_every_field_to_the_wire_format()
    {
        var t = new Todo
        {
            Id = Guid.NewGuid(), UserId = Guid.NewGuid(), Title = "T", Description = "D", DueDate = new DateOnly(2026, 7, 4),
            Priority = Priority.High, Status = TodoStatus.Completed, Category = "C", IsUrgent = true, Version = 3, ServerSeq = 9,
            CreatedAt = 1, UpdatedAt = 2, DeletedAt = 3, FieldTimes = new() { ["title"] = 7 },
        };

        var dto = TodoDto.From(t);

        (dto.Id, dto.Title, dto.Description, dto.DueDate, dto.Priority, dto.Status, dto.Category, dto.IsUrgent, dto.Version, dto.Seq, dto.CreatedAt, dto.UpdatedAt, dto.DeletedAt)
            .Should().Be((t.Id, "T", "D", "2026-07-04", "high", "completed", "C", true, 3L, 9L, 1L, 2L, 3L));
        dto.FieldTimes["title"].Should().Be(7);
    }

    [Fact]
    public void Snapshot_is_independent_of_later_changes_to_the_entity()
    {
        var t = new Todo { Title = "antes", FieldTimes = new() { ["title"] = 1 } };
        var dto = TodoDto.From(t);

        t.Title = "depois"; t.FieldTimes["title"] = 99;

        dto.Title.Should().Be("antes");
        dto.FieldTimes["title"].Should().Be(1);
    }

    [Fact]
    public void Serializes_with_camel_case_property_names()
    {
        var json = JsonSerializer.Serialize(TodoDto.From(new Todo { Title = "x" }), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        json.Should().Contain("\"isUrgent\"").And.Contain("\"fieldTimes\"").And.Contain("\"dueDate\"");
    }
}
