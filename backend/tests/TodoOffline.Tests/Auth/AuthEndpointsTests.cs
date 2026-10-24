using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;
using TodoOffline.Api.Features.Auth;
using TodoOffline.Tests.Integration;

namespace TodoOffline.Tests.Auth;

[Collection(PostgresCollection.Name)]
public sealed class AuthEndpointsTests : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly ApiFactory _factory;
    private readonly HttpClient _http;

    public AuthEndpointsTests(PostgresFixture pg)
    {
        _factory = new ApiFactory(pg.ConnectionString);
        _http = _factory.CreateClient();
    }

    public void Dispose() => _factory.Dispose();

    private static string NewEmail() => $"{Guid.NewGuid():N}@test.dev";

    private Task<HttpResponseMessage> Register(object body) => _http.PostAsJsonAsync("/api/auth/register", body);
    private Task<HttpResponseMessage> Login(object body) => _http.PostAsJsonAsync("/api/auth/login", body);

    [Fact]
    public async Task Register_returns_a_token_and_the_user()
    {
        var email = NewEmail();
        var res = await Register(new { name = "Maria", email, password = "secret123" });

        res.StatusCode.Should().Be(HttpStatusCode.OK);
        var auth = (await res.Content.ReadFromJsonAsync<AuthResponse>(Json))!;
        auth.Token.Should().NotBeNullOrEmpty();
        auth.User.Email.Should().Be(email);
        auth.User.Name.Should().Be("Maria");
        auth.ExpiresAt.Should().BeAfter(DateTimeOffset.UtcNow.AddDays(6));
    }

    [Fact]
    public async Task Register_normalizes_email_and_trims_the_name()
    {
        var email = NewEmail().ToUpperInvariant();
        var auth = (await (await Register(new { name = "  João  ", email = $"  {email}  ", password = "secret123" }))
            .Content.ReadFromJsonAsync<AuthResponse>(Json))!;

        auth.User.Email.Should().Be(email.ToLowerInvariant());
        auth.User.Name.Should().Be("João");
    }

    [Fact]
    public async Task Duplicate_email_is_rejected_even_with_different_casing()
    {
        var email = NewEmail();
        (await Register(new { name = "A", email, password = "secret123" })).StatusCode.Should().Be(HttpStatusCode.OK);

        var dup = await Register(new { name = "B", email = email.ToUpperInvariant(), password = "secret123" });

        dup.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Theory]
    [InlineData("", "ok@test.dev", "secret123")]
    [InlineData("Nome", "email-invalido", "secret123")]
    [InlineData("Nome", "", "secret123")]
    [InlineData("Nome", "ok@test.dev", "12345")]
    [InlineData("Nome", "ok@test.dev", "")]
    public async Task Register_validates_the_input(string name, string email, string password)
    {
        var res = await Register(new { name, email, password });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Register_rejects_a_name_longer_than_120_characters()
    {
        var res = await Register(new { name = new string('a', 121), email = NewEmail(), password = "secret123" });
        res.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Login_works_with_the_registered_credentials_case_insensitive_on_email()
    {
        var email = NewEmail();
        await Register(new { name = "L", email, password = "secret123" });

        var res = await Login(new { email = email.ToUpperInvariant(), password = "secret123" });

        res.StatusCode.Should().Be(HttpStatusCode.OK);
        (await res.Content.ReadFromJsonAsync<AuthResponse>(Json))!.User.Email.Should().Be(email);
    }

    [Fact]
    public async Task Wrong_password_and_unknown_email_get_the_same_generic_401()
    {
        var email = NewEmail();
        await Register(new { name = "L", email, password = "secret123" });

        var wrongPassword = await Login(new { email, password = "errada" });
        var unknownEmail = await Login(new { email = NewEmail(), password = "secret123" });

        wrongPassword.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        unknownEmail.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await wrongPassword.Content.ReadAsStringAsync()).Should().Be(await unknownEmail.Content.ReadAsStringAsync(),
            "a resposta não pode revelar quais e-mails existem");
    }

    [Fact]
    public async Task Login_with_missing_fields_is_unauthorized_not_a_server_error()
    {
        (await Login(new { })).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await Login(new { email = NewEmail() })).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Password_is_never_stored_in_clear_text()
    {
        var email = NewEmail();
        await Register(new { name = "H", email, password = "uma-senha-secreta" });

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TodoOffline.Api.Infrastructure.AppDbContext>();
        var stored = db.Users.Single(u => u.Email == email).PasswordHash;

        stored.Should().NotContain("uma-senha-secreta").And.StartWith("v1.");
    }

    [Fact]
    public async Task Issued_token_opens_protected_endpoints()
    {
        var auth = (await (await Register(new { name = "T", email = NewEmail(), password = "secret123" }))
            .Content.ReadFromJsonAsync<AuthResponse>(Json))!;
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/todos");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", auth.Token);

        (await _http.SendAsync(req)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("/api/todos")]
    public async Task Protected_endpoints_require_a_token(string path)
    {
        (await _http.GetAsync(path)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Garbage_and_expired_tokens_are_rejected()
    {
        async Task<HttpStatusCode> Call(string token)
        {
            var req = new HttpRequestMessage(HttpMethod.Get, "/api/todos");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return (await _http.SendAsync(req)).StatusCode;
        }

        (await Call("nao-e-um-jwt")).Should().Be(HttpStatusCode.Unauthorized);

        // expirado há 10 minutos (além do clock skew de 2 min), assinado com a chave correta
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes("dev-only-secret-change-me-0123456789abcdef"));
        var expired = new JwtSecurityToken("todo-offline", "todo-offline-app",
            [new System.Security.Claims.Claim("sub", Guid.NewGuid().ToString())],
            notBefore: DateTime.UtcNow.AddHours(-2), expires: DateTime.UtcNow.AddMinutes(-10),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
        (await Call(new JwtSecurityTokenHandler().WriteToken(expired))).Should().Be(HttpStatusCode.Unauthorized);

        // assinado com outra chave
        var forgedKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes("outra-chave-qualquer-0123456789-abcdef"));
        var forged = new JwtSecurityToken("todo-offline", "todo-offline-app",
            [new System.Security.Claims.Claim("sub", Guid.NewGuid().ToString())],
            expires: DateTime.UtcNow.AddHours(1),
            signingCredentials: new SigningCredentials(forgedKey, SecurityAlgorithms.HmacSha256));
        (await Call(new JwtSecurityTokenHandler().WriteToken(forged))).Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Health_and_openapi_are_public()
    {
        (await _http.GetAsync("/api/health")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await _http.GetAsync("/openapi/v1.json")).StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
