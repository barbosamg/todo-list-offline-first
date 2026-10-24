using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using TodoOffline.Api.Domain;
using TodoOffline.Api.Outbox;

namespace TodoOffline.Api.Infrastructure;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Todo> Todos => Set<Todo>();
    public DbSet<OutboxEvent> OutboxEvents => Set<OutboxEvent>();
    public DbSet<WebhookSubscription> WebhookSubscriptions => Set<WebhookSubscription>();
    public DbSet<OutboxDelivery> OutboxDeliveries => Set<OutboxDelivery>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>(e =>
        {
            e.HasIndex(u => u.Email).IsUnique();
            e.Property(u => u.Email).HasMaxLength(256);
            e.Property(u => u.Name).HasMaxLength(120);
        });

        b.Entity<Todo>(e =>
        {
            e.Property(t => t.Title).HasMaxLength(TodoMerger.MaxTitle);
            e.Property(t => t.Category).HasMaxLength(TodoMerger.MaxCategory);
            e.Property(t => t.Priority).HasConversion<string>().HasMaxLength(10);
            e.Property(t => t.Status).HasConversion<string>().HasMaxLength(10);
            e.Property(t => t.FieldTimes).HasColumnType("jsonb").HasConversion(
                v => JsonSerializer.Serialize(v, (JsonSerializerOptions?)null),
                v => JsonSerializer.Deserialize<Dictionary<string, long>>(v, (JsonSerializerOptions?)null) ?? new(),
                new ValueComparer<Dictionary<string, long>>(
                    (a, c) => JsonSerializer.Serialize(a, (JsonSerializerOptions?)null) == JsonSerializer.Serialize(c, (JsonSerializerOptions?)null),
                    v => JsonSerializer.Serialize(v, (JsonSerializerOptions?)null).GetHashCode(),
                    v => new Dictionary<string, long>(v)));

            // Pull incremental: "tudo do usuário com ServerSeq > cursor".
            e.HasIndex(t => new { t.UserId, t.ServerSeq });
            e.HasIndex(t => new { t.UserId, t.Category });
            e.HasOne<User>().WithMany().HasForeignKey(t => t.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<OutboxEvent>(e =>
        {
            e.Property(x => x.Sequence).UseIdentityAlwaysColumn();
            e.HasIndex(x => x.Sequence).IsUnique();
            e.Property(x => x.Type).HasMaxLength(60);
            e.Property(x => x.Payload).HasColumnType("jsonb");
        });

        b.Entity<WebhookSubscription>(e =>
        {
            e.HasIndex(s => s.Name).IsUnique();
            e.Property(s => s.Name).HasMaxLength(80);
            e.Property(s => s.Url).HasMaxLength(500);
        });

        b.Entity<OutboxDelivery>(e =>
        {
            e.Property(d => d.Status).HasConversion<string>().HasMaxLength(12);
            e.Property(d => d.LastError).HasMaxLength(500);
            e.HasIndex(d => new { d.EventId, d.SubscriptionId }).IsUnique();
            // Índice parcial: só entregas pendentes entram — o dispatcher varre apenas a "fila".
            e.HasIndex(d => new { d.SubscriptionId, d.AggregateId, d.Id })
                .HasFilter("\"Status\" = 'Pending'");
            e.HasIndex(d => new { d.NextAttemptAt }).HasFilter("\"Status\" = 'Pending'");
        });
    }
}
