namespace TodoOffline.Api.Outbox;

public enum DeliveryStatus { Pending = 0, Delivered = 1, Dead = 2 }

/// <summary>Evento de domínio gravado na MESMA transação da mudança (Transactional Outbox).</summary>
public class OutboxEvent
{
    /// <summary>Identificador estável do evento — chave de idempotência para os consumidores.</summary>
    public Guid Id { get; set; }

    /// <summary>Ordem global de gravação (identity).</summary>
    public long Sequence { get; set; }

    public Guid UserId { get; set; }
    public Guid AggregateId { get; set; }
    public long AggregateVersion { get; set; }
    public string Type { get; set; } = "";
    public string Payload { get; set; } = "{}";
    public DateTimeOffset OccurredAt { get; set; }
}

/// <summary>Consumidor externo (webhook) cadastrado.</summary>
public class WebhookSubscription
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Url { get; set; } = "";
    public string Secret { get; set; } = "";
    public bool Enabled { get; set; } = true;
}

/// <summary>Estado de entrega de um evento para UM consumidor (fan-out por assinatura).</summary>
public class OutboxDelivery
{
    public long Id { get; set; }
    public Guid EventId { get; set; }
    public OutboxEvent Event { get; set; } = null!;
    public Guid SubscriptionId { get; set; }
    public WebhookSubscription Subscription { get; set; } = null!;

    /// <summary>
    /// Desnormalizado para a consulta "há entrega anterior pendente do mesmo agregado?" sem join.
    /// A ordem entre entregas do mesmo agregado/assinatura é a do <see cref="Id"/> (identity): as
    /// escritas de um usuário são serializadas, então ids maiores = eventos mais novos.
    /// </summary>
    public Guid AggregateId { get; set; }

    public DeliveryStatus Status { get; set; } = DeliveryStatus.Pending;
    public int Attempts { get; set; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }
    public DateTimeOffset? DeliveredAt { get; set; }
    public string? LastError { get; set; }
}
