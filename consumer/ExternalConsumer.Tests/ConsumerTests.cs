using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;

namespace ExternalConsumer.Tests;

public sealed class ConsumerTests : IDisposable
{
    private const string Secret = "dev-shared-secret";
    private readonly WebApplicationFactory<Program> _factory = new();
    private readonly HttpClient _http;

    public ConsumerTests() => _http = _factory.CreateClient();

    public void Dispose() => _factory.Dispose();

    private static string Sign(string body, string secret = Secret) =>
        "sha256=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body)));

    private static (string Body, Guid EventId, Guid Aggregate) Payload(string type = "todo.created", long version = 1, string title = "Tarefa", Guid? aggregate = null, bool urgent = false)
    {
        var eventId = Guid.NewGuid();
        var agg = aggregate ?? Guid.NewGuid();
        var body = JsonSerializer.Serialize(new
        {
            eventId, type, occurredAt = DateTimeOffset.UtcNow, ownerId = Guid.NewGuid(),
            aggregate = new { type = "todo", id = agg, version },
            data = new { id = agg, title, priority = "medium", status = "pending", category = (string?)null, dueDate = (string?)null, isUrgent = urgent },
        }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        return (body, eventId, agg);
    }

    private async Task<HttpResponseMessage> Send((string Body, Guid EventId, Guid Aggregate) p, string? signature = null, int attempt = 1)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/webhooks/todos") { Content = new StringContent(p.Body, Encoding.UTF8, "application/json") };
        req.Headers.Add("X-Event-Id", p.EventId.ToString());
        req.Headers.Add("X-Event-Type", "todo.created");
        req.Headers.Add("X-Delivery-Attempt", attempt.ToString());
        req.Headers.Add("X-Signature", signature ?? Sign(p.Body));
        return await _http.SendAsync(req);
    }

    private async Task<JsonElement> Status(HttpResponseMessage res) => (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status");

    private async Task<JsonElement[]> Events() => (await _http.GetFromJsonAsync<JsonElement[]>("/api/events"))!;
    private async Task<JsonElement> State() => await _http.GetFromJsonAsync<JsonElement>("/api/state");

    [Fact]
    public async Task Valid_signed_event_is_applied_logged_and_projected()
    {
        var p = Payload(title: "Primeira", urgent: true);

        var res = await Send(p);

        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Status(res)).GetString().Should().Be("applied");
        var ev = (await Events()).Single();
        ev.GetProperty("outcome").GetString().Should().Be("aplicado");
        ev.GetProperty("eventId").GetString().Should().Be(p.EventId.ToString());
        ev.GetProperty("title").GetString().Should().Be("Primeira");
        var todos = (await State()).GetProperty("todos").EnumerateArray().ToList();
        todos.Should().ContainSingle();
        todos[0].GetProperty("data").GetProperty("isUrgent").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Invalid_signature_is_rejected_with_401_and_nothing_is_projected()
    {
        var res = await Send(Payload(), signature: "sha256=deadbeef");

        res.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await Events()).Single().GetProperty("outcome").GetString().Should().Be("assinatura-invalida");
        (await State()).GetProperty("todos").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task Signature_made_with_another_secret_is_rejected()
    {
        var p = Payload();
        (await Send(p, Sign(p.Body, "segredo-errado"))).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Missing_signature_header_is_rejected()
    {
        var p = Payload();
        var req = new HttpRequestMessage(HttpMethod.Post, "/webhooks/todos") { Content = new StringContent(p.Body, Encoding.UTF8, "application/json") };
        req.Headers.Add("X-Event-Id", p.EventId.ToString());

        (await _http.SendAsync(req)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_tampered_body_no_longer_matches_the_signature()
    {
        var p = Payload(title: "original");
        var tampered = (p.Body.Replace("original", "adulterado"), p.EventId, p.Aggregate);

        (await Send(tampered, Sign(p.Body))).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task The_same_event_delivered_twice_is_applied_once_and_acknowledged_as_duplicate()
    {
        var p = Payload();

        var first = await Send(p);
        var second = await Send(p, attempt: 2);

        (await Status(first)).GetString().Should().Be("applied");
        second.StatusCode.Should().Be(HttpStatusCode.OK, "duplicata precisa receber 2xx, senão o produtor reenviaria para sempre");
        (await Status(second)).GetString().Should().Be("duplicate");
        (await State()).GetProperty("todos").GetArrayLength().Should().Be(1);
        (await Events()).Select(e => e.GetProperty("outcome").GetString()).Should().Equal("duplicado-ignorado", "aplicado");
    }

    [Fact]
    public async Task An_older_version_arriving_late_does_not_overwrite_the_newer_state()
    {
        var agg = Guid.NewGuid();
        await Send(Payload("todo.updated", version: 5, title: "nova", aggregate: agg));

        var late = await Send(Payload("todo.updated", version: 3, title: "antiga", aggregate: agg));

        late.StatusCode.Should().Be(HttpStatusCode.OK);
        (await Status(late)).GetString().Should().Be("stale");
        var todo = (await State()).GetProperty("todos").EnumerateArray().Single();
        todo.GetProperty("data").GetProperty("title").GetString().Should().Be("nova");
        todo.GetProperty("version").GetInt64().Should().Be(5);
    }

    [Fact]
    public async Task Same_version_with_a_new_event_id_is_treated_as_stale()
    {
        var agg = Guid.NewGuid();
        await Send(Payload(version: 2, title: "a", aggregate: agg));
        (await Status(await Send(Payload(version: 2, title: "b", aggregate: agg)))).GetString().Should().Be("stale");
    }

    [Fact]
    public async Task Newer_versions_replace_the_projection()
    {
        var agg = Guid.NewGuid();
        await Send(Payload(version: 1, title: "v1", aggregate: agg));
        await Send(Payload("todo.updated", version: 2, title: "v2", aggregate: agg));

        var todo = (await State()).GetProperty("todos").EnumerateArray().Single();
        (todo.GetProperty("data").GetProperty("title").GetString(), todo.GetProperty("version").GetInt64()).Should().Be(("v2", 2L));
    }

    [Fact]
    public async Task Delete_event_removes_the_task_from_the_projection()
    {
        var agg = Guid.NewGuid();
        await Send(Payload(version: 1, aggregate: agg));
        await Send(Payload("todo.deleted", version: 2, aggregate: agg));

        (await State()).GetProperty("todos").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task Events_of_different_tasks_are_independent()
    {
        await Send(Payload(title: "A"));
        await Send(Payload(title: "B"));

        (await State()).GetProperty("todos").EnumerateArray().Select(t => t.GetProperty("data").GetProperty("title").GetString())
            .Should().BeEquivalentTo("A", "B");
    }

    [Fact]
    public async Task Injected_failures_return_503_exactly_n_times_then_recover()
    {
        (await _http.PostAsync("/admin/failures?count=3", null)).StatusCode.Should().Be(HttpStatusCode.OK);
        var p = Payload();

        var codes = new List<HttpStatusCode>();
        for (var attempt = 1; attempt <= 4; attempt++) codes.Add((await Send(p, attempt: attempt)).StatusCode);

        codes.Should().Equal(HttpStatusCode.ServiceUnavailable, HttpStatusCode.ServiceUnavailable, HttpStatusCode.ServiceUnavailable, HttpStatusCode.OK);
        (await Events()).Select(e => e.GetProperty("outcome").GetString())
            .Should().Equal("aplicado", "falha-injetada", "falha-injetada", "falha-injetada");
        (await State()).GetProperty("failuresPending").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task Injected_failures_are_logged_with_the_task_they_belong_to()
    {
        await _http.PostAsync("/admin/failures?count=1", null);
        var p = Payload(title: "Qual tarefa falhou?", version: 4);

        await Send(p);

        var failure = (await Events()).Last(); // o mais antigo = a falha
        failure.GetProperty("outcome").GetString().Should().Be("falha-injetada");
        failure.GetProperty("title").GetString().Should().Be("Qual tarefa falhou?");
        failure.GetProperty("aggregateId").GetGuid().Should().Be(p.Aggregate);
        failure.GetProperty("version").GetInt64().Should().Be(4);
    }

    [Fact]
    public async Task Signed_but_malformed_json_is_a_bad_request()
    {
        const string body = "{isto não é json";
        var req = new HttpRequestMessage(HttpMethod.Post, "/webhooks/todos") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        req.Headers.Add("X-Event-Id", Guid.NewGuid().ToString());
        req.Headers.Add("X-Signature", Sign(body));

        (await _http.SendAsync(req)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Invalid_signature_does_not_consume_an_injected_failure()
    {
        await _http.PostAsync("/admin/failures?count=1", null);
        await Send(Payload(), signature: "sha256=00");
        (await State()).GetProperty("failuresPending").GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task Negative_failure_count_is_clamped_to_zero()
    {
        await _http.PostAsync("/admin/failures?count=-5", null);
        (await State()).GetProperty("failuresPending").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task Reset_clears_events_state_and_pending_failures()
    {
        await Send(Payload());
        await _http.PostAsync("/admin/failures?count=2", null);

        await _http.PostAsync("/admin/reset", null);

        (await Events()).Should().BeEmpty();
        var state = await State();
        state.GetProperty("todos").GetArrayLength().Should().Be(0);
        state.GetProperty("failuresPending").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task After_a_reset_a_previously_seen_event_is_accepted_again()
    {
        var p = Payload();
        await Send(p);
        await _http.PostAsync("/admin/reset", null);

        (await Status(await Send(p))).GetString().Should().Be("applied");
    }

    [Fact]
    public async Task Event_log_is_newest_first()
    {
        await Send(Payload(title: "primeiro"));
        await Send(Payload(title: "segundo"));

        (await Events()).Select(e => e.GetProperty("title").GetString()).Should().Equal("segundo", "primeiro");
    }

    [Fact]
    public async Task The_status_panel_is_served()
    {
        var res = await _http.GetAsync("/");
        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await res.Content.ReadAsStringAsync()).Should().Contain("Consumidor externo simulado");
    }
}
