using System.Security.Cryptography;
using System.Text;

namespace TodoOffline.Api.Outbox;

public interface IWebhookSender
{
    /// <returns>(true, null) em caso de 2xx; caso contrário (false, motivo).</returns>
    Task<(bool Ok, string? Error)> SendAsync(WebhookSubscription subscription, OutboxEvent ev, int attempt, CancellationToken ct);
}

/// <summary>
/// Entrega HTTP assinada. A assinatura HMAC-SHA256 do corpo (header X-Signature) permite ao consumidor
/// autenticar a origem; X-Event-Id e X-Aggregate-Version permitem deduplicar e ignorar eventos antigos.
/// </summary>
public sealed class WebhookSender(HttpClient http) : IWebhookSender
{
    public static string Sign(string secret, string body)
    {
        var mac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body));
        return "sha256=" + Convert.ToHexStringLower(mac);
    }

    public async Task<(bool Ok, string? Error)> SendAsync(WebhookSubscription subscription, OutboxEvent ev, int attempt, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, subscription.Url)
        {
            Content = new StringContent(ev.Payload, Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("X-Event-Id", ev.Id.ToString());
        request.Headers.Add("X-Event-Type", ev.Type);
        request.Headers.Add("X-Aggregate-Id", ev.AggregateId.ToString());
        request.Headers.Add("X-Aggregate-Version", ev.AggregateVersion.ToString());
        request.Headers.Add("X-Delivery-Attempt", attempt.ToString());
        request.Headers.Add("X-Signature", Sign(subscription.Secret, ev.Payload));

        try
        {
            using var response = await http.SendAsync(request, ct);
            return response.IsSuccessStatusCode
                ? (true, null)
                : (false, $"HTTP {(int)response.StatusCode}");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return (false, "timeout");
        }
        catch (HttpRequestException e)
        {
            return (false, e.Message);
        }
    }
}
