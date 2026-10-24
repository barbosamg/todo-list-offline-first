using System.Text.Json;
using FluentAssertions;
using TodoOffline.Api.Domain;

namespace TodoOffline.Tests.Domain;

public class TodoMergerTests
{
    private const long Now = 1_000_000;

    private static FieldChange Text(string v, long at) => new(JsonSerializer.SerializeToElement(v), at);
    private static FieldChange Null(long at) => new(JsonSerializer.SerializeToElement<string?>(null), at);

    private static Dictionary<string, FieldChange> Changes(params (string Field, FieldChange Change)[] items) =>
        items.ToDictionary(i => i.Field, i => i.Change);

    private static Todo NewTodo() => new() { Id = Guid.NewGuid(), UserId = Guid.NewGuid() };

    [Fact]
    public void Different_fields_edited_concurrently_are_both_kept()
    {
        var todo = NewTodo();
        TodoMerger.Apply(todo, Changes(("title", Text("Comprar pão", 10))), Now);

        // dispositivo A mudou a prioridade; dispositivo B (offline) mudou a descrição
        TodoMerger.Apply(todo, Changes(("priority", Text("high", 20))), Now);
        var r = TodoMerger.Apply(todo, Changes(("description", Text("integral", 15))), Now);

        r.Changed.Should().BeTrue();
        todo.Priority.Should().Be(Priority.High);
        todo.Description.Should().Be("integral");
        todo.Title.Should().Be("Comprar pão");
    }

    [Fact]
    public void Same_field_last_edit_wins_regardless_of_arrival_order()
    {
        var todo = NewTodo();
        TodoMerger.Apply(todo, Changes(("title", Text("novo (t=30)", 30))), Now);

        // edição mais antiga chega depois (ficou offline): perde
        var r = TodoMerger.Apply(todo, Changes(("title", Text("velho (t=20)", 20))), Now);

        r.Changed.Should().BeFalse();
        r.RejectedFields.Should().Contain("title");
        todo.Title.Should().Be("novo (t=30)");
    }

    [Fact]
    public void Merge_is_commutative_and_idempotent()
    {
        var a = Changes(("title", Text("A", 10)), ("category", Text("casa", 50)));
        var b = Changes(("title", Text("B", 20)), ("category", Text("trabalho", 40)));

        var t1 = NewTodo();
        TodoMerger.Apply(t1, a, Now); TodoMerger.Apply(t1, b, Now); TodoMerger.Apply(t1, a, Now); // a,b,a (replay)

        var t2 = NewTodo();
        TodoMerger.Apply(t2, b, Now); TodoMerger.Apply(t2, a, Now); TodoMerger.Apply(t2, b, Now); // b,a,b

        (t1.Title, t1.Category).Should().Be((t2.Title, t2.Category)).And.Be(("B", "casa"));
    }

    [Fact]
    public void Same_timestamp_is_resolved_deterministically()
    {
        var x = NewTodo(); var y = NewTodo();
        TodoMerger.Apply(x, Changes(("title", Text("alfa", 10))), Now);
        TodoMerger.Apply(x, Changes(("title", Text("beta", 10))), Now);
        TodoMerger.Apply(y, Changes(("title", Text("beta", 10))), Now);
        TodoMerger.Apply(y, Changes(("title", Text("alfa", 10))), Now);

        x.Title.Should().Be(y.Title);
    }

    [Fact]
    public void Replaying_the_same_change_reports_no_change()
    {
        var todo = NewTodo();
        var c = Changes(("title", Text("Estudar", 10)));
        TodoMerger.Apply(todo, c, Now).Changed.Should().BeTrue();
        TodoMerger.Apply(todo, c, Now).Changed.Should().BeFalse();
    }

    [Fact]
    public void Future_timestamps_are_clamped_to_server_time()
    {
        var todo = NewTodo();
        TodoMerger.Apply(todo, Changes(("title", Text("relógio adiantado", Now + 10_000_000))), Now);
        todo.FieldTimes["title"].Should().Be(Now);
    }

    [Fact]
    public void Delete_is_sticky_and_later_edits_are_ignored()
    {
        var todo = NewTodo();
        TodoMerger.Apply(todo, Changes(("title", Text("x", 10))), Now);
        TodoMerger.Delete(todo, 20, Now).Should().BeTrue();

        var r = TodoMerger.Apply(todo, Changes(("title", Text("editado depois", 99))), Now);

        r.Changed.Should().BeFalse();
        todo.Title.Should().Be("x");
        TodoMerger.Delete(todo, 30, Now).Should().BeFalse("já removida");
    }

    [Fact]
    public void Urgent_flag_follows_title_and_description()
    {
        var todo = NewTodo();
        TodoMerger.Apply(todo, Changes(("title", Text("Pagar conta", 10))), Now);
        todo.IsUrgent.Should().BeFalse();

        TodoMerger.Apply(todo, Changes(("description", Text("É URGENTE", 11))), Now);
        todo.IsUrgent.Should().BeTrue();

        TodoMerger.Apply(todo, Changes(("description", Null(12))), Now);
        todo.IsUrgent.Should().BeFalse();
    }

    [Theory]
    [InlineData("title", "")]
    [InlineData("priority", "critical")]
    [InlineData("status", "doing")]
    [InlineData("dueDate", "31/12/2026")]
    [InlineData("nope", "x")]
    public void Invalid_values_reject_the_whole_mutation_without_side_effects(string field, string value)
    {
        var todo = NewTodo();
        var r = TodoMerger.Apply(todo, Changes(("description", Text("ok", 10)), (field, Text(value, 10))), Now);

        r.Error.Should().NotBeNull();
        todo.Description.Should().BeNull("a mutação é atômica");
    }

    [Fact]
    public void Title_is_trimmed_and_limited()
    {
        var todo = NewTodo();
        TodoMerger.Apply(todo, Changes(("title", Text("  espaços  ", 10))), Now);
        todo.Title.Should().Be("espaços");

        TodoMerger.Apply(NewTodo(), Changes(("title", Text(new string('a', 201), 10))), Now).Error.Should().NotBeNull();
    }
}
