using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TodoOffline.Api.Infrastructure;
using TodoOffline.Api.Outbox;

namespace TodoOffline.Tests.Integration;

[Collection(PostgresCollection.Name)]
public sealed class DatabaseInitializerTests(PostgresFixture pg)
{
    private static IDictionary<string, string?> SeedOn() => new Dictionary<string, string?>
    {
        ["Seed:Enabled"] = "true",
        ["Seed:Email"] = "seed@test.dev",
        ["Seed:Password"] = "Seed@1234",
        ["Seed:Name"] = "Seeded",
    };

    private static async Task<T> WithDb<T>(ApiFactory f, Func<AppDbContext, Task<T>> action)
    {
        using var scope = f.Services.CreateScope();
        return await action(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    [Fact]
    public async Task Creates_the_seed_user_with_a_hashed_password_and_can_log_in()
    {
        using var f = new ApiFactory(pg.ConnectionString, SeedOn());
        _ = f.CreateClient(); // sobe a aplicação (migrations + seed)

        var user = await WithDb(f, db => db.Users.AsNoTracking().SingleAsync(u => u.Email == "seed@test.dev"));

        user.Name.Should().Be("Seeded");
        user.PasswordHash.Should().NotContain("Seed@1234");
        PasswordHasher.Verify("Seed@1234", user.PasswordHash).Should().BeTrue();

        var res = await f.CreateClient().PostAsJsonAsync("/api/auth/login", new { email = "seed@test.dev", password = "Seed@1234" });
        res.IsSuccessStatusCode.Should().BeTrue();
    }

    [Fact]
    public async Task Seed_is_idempotent_across_restarts()
    {
        using var f = new ApiFactory(pg.ConnectionString, SeedOn());
        _ = f.CreateClient();

        await DatabaseInitializer.InitializeAsync(f.Services);
        await DatabaseInitializer.InitializeAsync(f.Services);

        (await WithDb(f, db => db.Users.CountAsync(u => u.Email == "seed@test.dev"))).Should().Be(1);
    }

    [Fact]
    public async Task Seed_can_be_disabled()
    {
        using var f = new ApiFactory(pg.ConnectionString); // Seed:Enabled=false
        _ = f.CreateClient();

        (await WithDb(f, db => db.Users.CountAsync())).Should().Be(0);
    }

    [Fact]
    public async Task Consumers_from_configuration_are_upserted_and_enabled()
    {
        using var f = new ApiFactory(pg.ConnectionString);
        _ = f.CreateClient();

        var sub = await WithDb(f, db => db.WebhookSubscriptions.AsNoTracking().SingleAsync(s => s.Name == "test-consumer"));

        (sub.Url, sub.Secret, sub.Enabled).Should().Be(("http://consumer.test/webhooks", "test-secret", true));
    }

    [Fact]
    public async Task Consumers_missing_from_configuration_are_disabled_and_reappear_when_configured_again()
    {
        using var f = new ApiFactory(pg.ConnectionString);
        _ = f.CreateClient();
        await WithDb(f, async db =>
        {
            db.WebhookSubscriptions.Add(new WebhookSubscription { Id = Guid.NewGuid(), Name = "removido", Url = "http://x", Secret = "s" });
            await db.SaveChangesAsync();
            return 0;
        });

        await DatabaseInitializer.InitializeAsync(f.Services);

        (await WithDb(f, db => db.WebhookSubscriptions.AsNoTracking().SingleAsync(s => s.Name == "removido"))).Enabled.Should().BeFalse();
        (await WithDb(f, db => db.WebhookSubscriptions.AsNoTracking().SingleAsync(s => s.Name == "test-consumer"))).Enabled.Should().BeTrue();
    }

    [Fact]
    public async Task Changing_the_url_or_secret_in_configuration_updates_the_existing_row()
    {
        using var f = new ApiFactory(pg.ConnectionString);
        _ = f.CreateClient();
        await WithDb(f, async db =>
        {
            var s = await db.WebhookSubscriptions.SingleAsync(x => x.Name == "test-consumer");
            s.Url = "http://velha"; s.Secret = "velha"; s.Enabled = false;
            await db.SaveChangesAsync();
            return 0;
        });

        await DatabaseInitializer.InitializeAsync(f.Services);

        var sub = await WithDb(f, db => db.WebhookSubscriptions.AsNoTracking().SingleAsync(x => x.Name == "test-consumer"));
        (sub.Url, sub.Secret, sub.Enabled).Should().Be(("http://consumer.test/webhooks", "test-secret", true));
        (await WithDb(f, db => db.WebhookSubscriptions.CountAsync(x => x.Name == "test-consumer"))).Should().Be(1);
    }

    [Fact]
    public async Task Migrations_are_applied_and_tables_exist()
    {
        using var f = new ApiFactory(pg.ConnectionString);
        _ = f.CreateClient();

        var applied = await WithDb(f, db => db.Database.GetAppliedMigrationsAsync());

        applied.Should().NotBeEmpty();
        (await WithDb(f, db => db.Database.GetPendingMigrationsAsync())).Should().BeEmpty();
    }
}

