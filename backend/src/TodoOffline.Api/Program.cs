using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Scalar.AspNetCore;
using TodoOffline.Api.Features.Auth;
using TodoOffline.Api.Features.Sync;
using TodoOffline.Api.Infrastructure;
using TodoOffline.Api.Outbox;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

builder.Services.Configure<JwtOptions>(builder.Configuration.GetSection("Jwt"));
builder.Services.Configure<WebhookOptions>(builder.Configuration.GetSection(WebhookOptions.Section));
builder.Services.Configure<SeedOptions>(builder.Configuration.GetSection(SeedOptions.Section));

var jwt = builder.Configuration.GetSection("Jwt").Get<JwtOptions>() ?? new JwtOptions();
if (jwt.Key.Length < 32) throw new InvalidOperationException("Jwt:Key deve ter ao menos 32 caracteres.");

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.MapInboundClaims = false;
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidIssuer = jwt.Issuer,
            ValidAudience = jwt.Audience,
            IssuerSigningKey = jwt.SigningKey,
            ClockSkew = TimeSpan.FromMinutes(2),
        };
    });
builder.Services.AddAuthorization();

builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? [])
    .AllowAnyHeader().AllowAnyMethod()));

builder.Services.AddOpenApi();
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<OutboxSignal>();
builder.Services.AddSingleton<TokenService>();
builder.Services.AddScoped<SyncService>();
builder.Services.AddHttpClient<IWebhookSender, WebhookSender>((sp, http) =>
{
    var o = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<WebhookOptions>>().Value;
    http.Timeout = TimeSpan.FromSeconds(o.RequestTimeoutSeconds);
});
builder.Services.AddHostedService<OutboxDispatcher>();

var app = builder.Build();

if (builder.Configuration.GetValue("Database:AutoMigrate", true))
    await DatabaseInitializer.InitializeAsync(app.Services);

app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

app.MapOpenApi();
app.MapScalarApiReference();

// Usado pelo frontend para confirmar conectividade real com o servidor (navigator.onLine mente).
app.MapGet("/api/health", () => Results.Ok(new { status = "ok" })).WithTags("Health");

app.MapAuth();
app.MapSync();

app.Run();

public partial class Program;
