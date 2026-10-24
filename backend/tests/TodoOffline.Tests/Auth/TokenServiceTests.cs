using System.IdentityModel.Tokens.Jwt;
using FluentAssertions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Microsoft.IdentityModel.Tokens;
using TodoOffline.Api.Domain;
using TodoOffline.Api.Features.Auth;

namespace TodoOffline.Tests.Auth;

public class TokenServiceTests
{
    private static readonly JwtOptions Options = new()
    {
        Key = "unit-test-secret-key-0123456789-abcdef",
        Issuer = "issuer-x",
        Audience = "audience-y",
        ExpiresInDays = 3,
    };

    private static readonly User Alice = new() { Id = Guid.NewGuid(), Email = "alice@test.dev", Name = "Alice" };

    private static (TokenService Service, FakeTimeProvider Clock) Create()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 3, 10, 12, 0, 0, TimeSpan.Zero));
        return (new TokenService(Microsoft.Extensions.Options.Options.Create(Options), clock), clock);
    }

    [Fact]
    public void Token_carries_subject_email_name_issuer_and_audience()
    {
        var (svc, _) = Create();
        var (token, _) = svc.Create(Alice);

        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);

        jwt.Subject.Should().Be(Alice.Id.ToString());
        jwt.Claims.Should().Contain(c => c.Type == JwtRegisteredClaimNames.Email && c.Value == "alice@test.dev");
        jwt.Claims.Should().Contain(c => c.Type == "name" && c.Value == "Alice");
        jwt.Issuer.Should().Be("issuer-x");
        jwt.Audiences.Should().Contain("audience-y");
    }

    [Fact]
    public void Expiry_follows_the_configured_number_of_days()
    {
        var (svc, clock) = Create();
        var (token, expires) = svc.Create(Alice);

        expires.Should().Be(clock.GetUtcNow().AddDays(3));
        new JwtSecurityTokenHandler().ReadJwtToken(token).ValidTo
            .Should().BeCloseTo(expires.UtcDateTime, TimeSpan.FromSeconds(1));
    }

    [Fact]
    public void Token_validates_with_the_right_key_and_fails_with_another()
    {
        var (svc, clock) = Create();
        var (token, _) = svc.Create(Alice);
        var handler = new JwtSecurityTokenHandler();

        TokenValidationParameters Params(string key) => new()
        {
            ValidIssuer = Options.Issuer,
            ValidAudience = Options.Audience,
            IssuerSigningKey = new SymmetricSecurityKey(System.Text.Encoding.UTF8.GetBytes(key)),
            // o relógio do teste é fixo em 2026-03-10: valida "naquele dia"
            LifetimeValidator = (nbf, exp, _, _) => exp > clock.GetUtcNow().UtcDateTime,
        };

        handler.ValidateToken(token, Params(Options.Key), out _).Should().NotBeNull();
        var act = () => handler.ValidateToken(token, Params("outra-chave-qualquer-0123456789-abcdef"), out _);
        act.Should().Throw<SecurityTokenException>();
    }

    [Fact]
    public void Tampered_token_is_rejected()
    {
        var (svc, clock) = Create();
        var (token, _) = svc.Create(Alice);
        var parts = token.Split('.');
        var forged = $"{parts[0]}.{parts[1][..^2]}AA.{parts[2]}";

        var act = () => new JwtSecurityTokenHandler().ValidateToken(forged, new TokenValidationParameters
        {
            ValidIssuer = Options.Issuer,
            ValidAudience = Options.Audience,
            IssuerSigningKey = Options.SigningKey,
            LifetimeValidator = (_, exp, _, _) => exp > clock.GetUtcNow().UtcDateTime,
        }, out _);

        act.Should().Throw<Exception>();
    }
}
