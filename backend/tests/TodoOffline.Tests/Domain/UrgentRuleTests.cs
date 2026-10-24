using System.Text.Json;
using FluentAssertions;
using TodoOffline.Api.Domain;

namespace TodoOffline.Tests.Domain;

public class UrgentRuleTests
{
    private sealed record Case(string Name, string? Title, string? Description, bool Urgent);

    /// <summary>Os mesmos vetores são executados pelo frontend (urgent-rule.spec.ts): garante paridade offline/online.</summary>
    public static TheoryData<string, string?, string?, bool> SharedCases()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "urgent-rule-cases.json");
        var cases = JsonSerializer.Deserialize<List<Case>>(File.ReadAllText(path), new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        var data = new TheoryData<string, string?, string?, bool>();
        foreach (var c in cases) data.Add(c.Name, c.Title, c.Description, c.Urgent);
        return data;
    }

    [Theory]
    [MemberData(nameof(SharedCases))]
    public void Matches_shared_vectors(string name, string? title, string? description, bool expected)
    {
        UrgentRule.IsUrgent(title, description).Should().Be(expected, name);
    }

    [Fact]
    public void Handles_nulls() => UrgentRule.IsUrgent(null, null).Should().BeFalse();
}
