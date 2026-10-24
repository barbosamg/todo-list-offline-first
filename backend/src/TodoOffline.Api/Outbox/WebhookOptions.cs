namespace TodoOffline.Api.Outbox;

public sealed class WebhookOptions
{
    public const string Section = "Webhooks";

    public List<SubscriberConfig> Subscribers { get; set; } = [];

    /// <summary>Após esta quantidade de tentativas a entrega vira "Dead" (dead-letter) e libera o próximo evento do agregado.</summary>
    public int MaxAttempts { get; set; } = 8;
    public int BatchSize { get; set; } = 50;
    public int RequestTimeoutSeconds { get; set; } = 5;
    public int PollIntervalMs { get; set; } = 1000;
    public int BaseBackoffSeconds { get; set; } = 2;
    public int MaxBackoffSeconds { get; set; } = 300;

    /// <summary>Lease do claim: se o processo morrer no meio da entrega, outra instância reassume após este prazo.</summary>
    public int LeaseSeconds { get; set; } = 30;
}

public sealed class SubscriberConfig
{
    public string Name { get; set; } = "";
    public string Url { get; set; } = "";
    public string Secret { get; set; } = "";
}
