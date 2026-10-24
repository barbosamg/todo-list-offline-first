using System.Net;
using System.Security.Cryptography;
using System.Text;
using FluentAssertions;
using TodoOffline.Api.Outbox;

namespace TodoOffline.Tests.Outbox;

public class WebhookSenderTests
{
    private sealed class StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        public List<(HttpRequestMessage Request, string Body)> Seen { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Seen.Add((request, request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct)));
            return await respond(request, ct);
        }
    }

    private static readonly WebhookSubscription Sub = new() { Id = Guid.NewGuid(), Name = "c1", Url = "http://consumer.test/hook", Secret = "s3cr3t" };

    private static OutboxEvent Event(string payload = "{\"a\":1}") => new()
    {
        Id = Guid.NewGuid(),
        AggregateId = Guid.NewGuid(),
        AggregateVersion = 7,
        Type = "todo.updated",
        Payload = payload,
    };

    [Fact]
    public void Signature_is_hmac_sha256_hex_of_the_exact_body()
    {
        var expected = "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes("k"), Encoding.UTF8.GetBytes("corpo"))).ToLowerInvariant();
        WebhookSender.Sign("k", "corpo").Should().Be(expected);
    }

    [Fact]
    public void Signature_changes_with_body_or_secret()
    {
        WebhookSender.Sign("k", "a").Should().NotBe(WebhookSender.Sign("k", "b"));
        WebhookSender.Sign("k1", "a").Should().NotBe(WebhookSender.Sign("k2", "a"));
        WebhookSender.Sign("k", "a").Should().Be(WebhookSender.Sign("k", "a"));
    }

    [Fact]
    public async Task Posts_the_payload_with_all_the_delivery_headers()
    {
        var handler = new StubHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)));
        var sender = new WebhookSender(new HttpClient(handler));
        var ev = Event("{\"x\":\"y\"}");

        var (ok, error) = await sender.SendAsync(Sub, ev, attempt: 3, CancellationToken.None);

        ok.Should().BeTrue();
        error.Should().BeNull();
        var (req, body) = handler.Seen.Single();
        req.Method.Should().Be(HttpMethod.Post);
        req.RequestUri!.ToString().Should().Be("http://consumer.test/hook");
        body.Should().Be("{\"x\":\"y\"}");
        req.Content!.Headers.ContentType!.MediaType.Should().Be("application/json");
        req.Headers.GetValues("X-Event-Id").Single().Should().Be(ev.Id.ToString());
        req.Headers.GetValues("X-Event-Type").Single().Should().Be("todo.updated");
        req.Headers.GetValues("X-Aggregate-Id").Single().Should().Be(ev.AggregateId.ToString());
        req.Headers.GetValues("X-Aggregate-Version").Single().Should().Be("7");
        req.Headers.GetValues("X-Delivery-Attempt").Single().Should().Be("3");
        req.Headers.GetValues("X-Signature").Single().Should().Be(WebhookSender.Sign("s3cr3t", "{\"x\":\"y\"}"));
    }

    [Theory]
    [InlineData(HttpStatusCode.NoContent, true)]
    [InlineData(HttpStatusCode.Created, true)]
    [InlineData(HttpStatusCode.BadRequest, false)]
    [InlineData(HttpStatusCode.Unauthorized, false)]
    [InlineData(HttpStatusCode.InternalServerError, false)]
    [InlineData(HttpStatusCode.ServiceUnavailable, false)]
    public async Task Only_2xx_counts_as_delivered(HttpStatusCode status, bool delivered)
    {
        var sender = new WebhookSender(new HttpClient(new StubHandler((_, _) => Task.FromResult(new HttpResponseMessage(status)))));

        var (ok, error) = await sender.SendAsync(Sub, Event(), 1, CancellationToken.None);

        ok.Should().Be(delivered);
        if (!delivered) error.Should().Be($"HTTP {(int)status}");
    }

    [Fact]
    public async Task Network_failure_is_reported_not_thrown()
    {
        var sender = new WebhookSender(new HttpClient(new StubHandler((_, _) => throw new HttpRequestException("connection refused"))));

        var (ok, error) = await sender.SendAsync(Sub, Event(), 1, CancellationToken.None);

        ok.Should().BeFalse();
        error.Should().Contain("connection refused");
    }

    [Fact]
    public async Task Request_timeout_is_reported_as_timeout()
    {
        var handler = new StubHandler(async (_, ct) =>
        {
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        var sender = new WebhookSender(new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(100) });

        var (ok, error) = await sender.SendAsync(Sub, Event(), 1, CancellationToken.None);

        ok.Should().BeFalse();
        error.Should().Be("timeout");
    }

    [Fact]
    public async Task Cancellation_requested_by_the_caller_is_not_swallowed()
    {
        var handler = new StubHandler(async (_, ct) =>
        {
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        var sender = new WebhookSender(new HttpClient(handler));
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

        var act = () => sender.SendAsync(Sub, Event(), 1, cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }
}
