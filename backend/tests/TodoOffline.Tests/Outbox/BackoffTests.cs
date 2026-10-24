using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using TodoOffline.Api.Outbox;

namespace TodoOffline.Tests.Outbox;

public class BackoffTests
{
    private static OutboxDispatcher Dispatcher(int baseSeconds = 2, int maxSeconds = 300) => new(
        null!, new OutboxSignal(),
        Options.Create(new WebhookOptions { BaseBackoffSeconds = baseSeconds, MaxBackoffSeconds = maxSeconds }),
        new FakeTimeProvider(), NullLogger<OutboxDispatcher>.Instance);

    [Theory]
    [InlineData(1, 2)]
    [InlineData(2, 4)]
    [InlineData(3, 8)]
    [InlineData(4, 16)]
    [InlineData(5, 32)]
    public void Grows_exponentially_within_the_jitter_band(int attempts, double nominalSeconds)
    {
        var d = Dispatcher();
        for (var i = 0; i < 200; i++)
            d.Backoff(attempts).TotalSeconds.Should().BeInRange(nominalSeconds * 0.8, nominalSeconds * 1.2);
    }

    [Theory]
    [InlineData(10)]
    [InlineData(30)]
    [InlineData(500)]
    public void Is_capped_at_the_maximum(int attempts)
    {
        var d = Dispatcher(maxSeconds: 300);
        for (var i = 0; i < 100; i++) d.Backoff(attempts).TotalSeconds.Should().BeInRange(240, 360);
    }

    [Fact]
    public void Never_decreases_on_average_as_attempts_grow()
    {
        var d = Dispatcher();
        var means = Enumerable.Range(1, 8)
            .Select(a => Enumerable.Range(0, 200).Average(_ => d.Backoff(a).TotalSeconds)).ToList();
        means.Zip(means.Skip(1)).Should().OnlyContain(p => p.Second > p.First);
    }

    [Fact]
    public void Jitter_actually_varies_the_delay()
    {
        var d = Dispatcher();
        Enumerable.Range(0, 50).Select(_ => d.Backoff(3).TotalMilliseconds).Distinct().Should().HaveCountGreaterThan(10);
    }
}
