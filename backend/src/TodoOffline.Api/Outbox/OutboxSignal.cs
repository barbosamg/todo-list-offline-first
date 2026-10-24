using System.Threading.Channels;

namespace TodoOffline.Api.Outbox;

/// <summary>
/// Acorda o dispatcher logo após um commit com eventos novos (latência de ~ms em vez de esperar o polling).
/// O polling continua existindo como rede de segurança (reinícios, retries agendados, outras instâncias).
/// </summary>
public sealed class OutboxSignal
{
    private readonly Channel<bool> _channel = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite });

    public void Notify() => _channel.Writer.TryWrite(true);

    public async Task WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try { await _channel.Reader.ReadAsync(cts.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { /* timeout: segue o polling */ }
    }
}
