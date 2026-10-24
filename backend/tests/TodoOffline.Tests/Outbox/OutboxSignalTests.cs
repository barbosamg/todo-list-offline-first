using System.Diagnostics;
using FluentAssertions;
using TodoOffline.Api.Outbox;

namespace TodoOffline.Tests.Outbox;

public class OutboxSignalTests
{
    [Fact]
    public async Task Notify_wakes_a_waiter_immediately()
    {
        var signal = new OutboxSignal();
        var sw = Stopwatch.StartNew();
        var wait = signal.WaitAsync(TimeSpan.FromSeconds(10), CancellationToken.None);

        signal.Notify();
        await wait;

        sw.Elapsed.Should().BeLessThan(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task Without_notification_the_wait_ends_at_the_timeout()
    {
        var signal = new OutboxSignal();
        var sw = Stopwatch.StartNew();

        await signal.WaitAsync(TimeSpan.FromMilliseconds(120), CancellationToken.None);

        sw.Elapsed.Should().BeGreaterThan(TimeSpan.FromMilliseconds(90)).And.BeLessThan(TimeSpan.FromSeconds(3));
    }

    [Fact]
    public async Task A_notification_before_the_wait_is_not_lost()
    {
        var signal = new OutboxSignal();
        signal.Notify();
        var sw = Stopwatch.StartNew();

        await signal.WaitAsync(TimeSpan.FromSeconds(10), CancellationToken.None);

        sw.Elapsed.Should().BeLessThan(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task Many_notifications_collapse_into_a_single_wakeup()
    {
        var signal = new OutboxSignal();
        for (var i = 0; i < 50; i++) signal.Notify();

        await signal.WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None); // consome o único sinal

        var sw = Stopwatch.StartNew();
        await signal.WaitAsync(TimeSpan.FromMilliseconds(150), CancellationToken.None); // não há mais nada
        sw.Elapsed.Should().BeGreaterThan(TimeSpan.FromMilliseconds(100));
    }

    [Fact]
    public async Task Cancellation_propagates()
    {
        var signal = new OutboxSignal();
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

        var act = () => signal.WaitAsync(TimeSpan.FromSeconds(10), cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }
}
