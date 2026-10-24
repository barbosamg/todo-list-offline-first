namespace TodoOffline.Api.Domain;

public class User
{
    public Guid Id { get; set; }
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public string PasswordHash { get; set; } = "";

    /// <summary>
    /// Contador de mudanças do usuário. É incrementado sob lock de linha (SELECT ... FOR UPDATE),
    /// o que serializa as escritas de um mesmo usuário e garante que a ordem do contador
    /// coincide com a ordem de commit: um cursor de "pull" nunca pula uma mudança.
    /// </summary>
    public long SyncSeq { get; set; }
}
