using System.Net.Mail;
using Microsoft.EntityFrameworkCore;
using TodoOffline.Api.Domain;
using TodoOffline.Api.Infrastructure;

namespace TodoOffline.Api.Features.Auth;

public sealed record RegisterRequest(string? Name, string? Email, string? Password);
public sealed record LoginRequest(string? Email, string? Password);
public sealed record UserDto(Guid Id, string Email, string Name);
public sealed record AuthResponse(string Token, DateTimeOffset ExpiresAt, UserDto User);

public static class AuthEndpoints
{
    public static void MapAuth(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/auth").WithTags("Auth");

        g.MapPost("/register", async (RegisterRequest req, AppDbContext db, TokenService tokens, CancellationToken ct) =>
        {
            var name = req.Name?.Trim();
            var email = req.Email?.Trim().ToLowerInvariant();
            if (string.IsNullOrEmpty(name) || name.Length > 120)
                return Results.ValidationProblem(Error("name", "Informe o nome (até 120 caracteres)."));
            if (!IsEmail(email))
                return Results.ValidationProblem(Error("email", "E-mail inválido."));
            if (req.Password is not { Length: >= 6 })
                return Results.ValidationProblem(Error("password", "A senha deve ter ao menos 6 caracteres."));
            if (await db.Users.AnyAsync(u => u.Email == email, ct))
                return Results.Conflict(new { error = "E-mail já cadastrado." });

            var user = new User { Id = Guid.NewGuid(), Name = name, Email = email!, PasswordHash = PasswordHasher.Hash(req.Password) };
            db.Users.Add(user);
            await db.SaveChangesAsync(ct);
            return Results.Ok(Issue(user, tokens));
        });

        g.MapPost("/login", async (LoginRequest req, AppDbContext db, TokenService tokens, CancellationToken ct) =>
        {
            var email = req.Email?.Trim().ToLowerInvariant();
            var user = email is null ? null : await db.Users.FirstOrDefaultAsync(u => u.Email == email, ct);
            // Mesma resposta para "usuário inexistente" e "senha errada" (não vaza quais e-mails existem).
            if (user is null || req.Password is null || !PasswordHasher.Verify(req.Password, user.PasswordHash))
                return Results.Json(new { error = "E-mail ou senha inválidos." }, statusCode: StatusCodes.Status401Unauthorized);
            return Results.Ok(Issue(user, tokens));
        });
    }

    private static AuthResponse Issue(User user, TokenService tokens)
    {
        var (token, expires) = tokens.Create(user);
        return new AuthResponse(token, expires, new UserDto(user.Id, user.Email, user.Name));
    }

    private static Dictionary<string, string[]> Error(string field, string message) => new() { [field] = [message] };

    private static bool IsEmail(string? value) =>
        !string.IsNullOrEmpty(value) && value.Length <= 256 && MailAddress.TryCreate(value, out var a) && a.Address == value;
}
