using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using TodoOffline.Api.Domain;
using TodoOffline.Api.Outbox;

namespace TodoOffline.Api.Infrastructure;

public sealed class SeedOptions
{
    public const string Section = "Seed";
    public bool Enabled { get; set; } = true;
    public string Email { get; set; } = "demo@way2.dev";
    public string Password { get; set; } = "Demo@1234";
    public string Name { get; set; } = "Usuário Demo";
}

public static class DatabaseInitializer
{
    /// <summary>Aplica migrations, sincroniza os consumidores (webhooks) da configuração e cria o usuário de teste.</summary>
    public static async Task InitializeAsync(IServiceProvider services, CancellationToken ct = default)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var seed = scope.ServiceProvider.GetRequiredService<IOptions<SeedOptions>>().Value;
        var webhooks = scope.ServiceProvider.GetRequiredService<IOptions<WebhookOptions>>().Value;

        await db.Database.MigrateAsync(ct);

        // Consumidores: a configuração é a fonte da verdade (upsert por nome; os ausentes são desabilitados).
        var existing = await db.WebhookSubscriptions.ToListAsync(ct);
        foreach (var cfg in webhooks.Subscribers)
        {
            var sub = existing.FirstOrDefault(s => s.Name == cfg.Name);
            if (sub is null) db.WebhookSubscriptions.Add(new WebhookSubscription { Id = Guid.NewGuid(), Name = cfg.Name, Url = cfg.Url, Secret = cfg.Secret });
            else { sub.Url = cfg.Url; sub.Secret = cfg.Secret; sub.Enabled = true; }
        }
        foreach (var gone in existing.Where(s => webhooks.Subscribers.All(c => c.Name != s.Name))) gone.Enabled = false;

        if (seed.Enabled && !await db.Users.AnyAsync(u => u.Email == seed.Email, ct))
        {
            db.Users.Add(new User
            {
                Id = Guid.NewGuid(),
                Email = seed.Email,
                Name = seed.Name,
                PasswordHash = PasswordHasher.Hash(seed.Password),
            });
        }

        await db.SaveChangesAsync(ct);
    }
}
