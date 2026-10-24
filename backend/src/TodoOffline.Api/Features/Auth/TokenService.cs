using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using TodoOffline.Api.Domain;

namespace TodoOffline.Api.Features.Auth;

public sealed class JwtOptions
{
    public string Key { get; set; } = "";
    public string Issuer { get; set; } = "todo-offline";
    public string Audience { get; set; } = "todo-offline-app";

    /// <summary>
    /// Validade longa de propósito: o app é usado em campo, possivelmente por dias sem conexão.
    /// Em produção: access token curto + refresh token rotativo (ver README, "Próximos passos").
    /// </summary>
    public int ExpiresInDays { get; set; } = 7;

    public SymmetricSecurityKey SigningKey => new(Encoding.UTF8.GetBytes(Key));
}

public sealed class TokenService(IOptions<JwtOptions> options, TimeProvider clock)
{
    private readonly JwtOptions _o = options.Value;

    public (string Token, DateTimeOffset ExpiresAt) Create(User user)
    {
        var expires = clock.GetUtcNow().AddDays(_o.ExpiresInDays);
        var token = new JwtSecurityToken(
            _o.Issuer, _o.Audience,
            [
                new Claim(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
                new Claim(JwtRegisteredClaimNames.Email, user.Email),
                new Claim("name", user.Name),
            ],
            expires: expires.UtcDateTime,
            signingCredentials: new SigningCredentials(_o.SigningKey, SecurityAlgorithms.HmacSha256));
        return (new JwtSecurityTokenHandler().WriteToken(token), expires);
    }
}
