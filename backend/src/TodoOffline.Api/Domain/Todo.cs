namespace TodoOffline.Api.Domain;

public enum Priority { Low = 0, Medium = 1, High = 2 }

public enum TodoStatus { Pending = 0, Completed = 1 }

/// <summary>
/// Tarefa. Cada campo editável tem o seu próprio "relógio" em <see cref="FieldTimes"/>
/// (epoch ms da edição), o que permite mesclar edições concorrentes campo a campo (LWW por campo).
/// </summary>
public class Todo
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }

    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public DateOnly? DueDate { get; set; }
    public Priority Priority { get; set; } = Priority.Medium;
    public TodoStatus Status { get; set; } = TodoStatus.Pending;
    public string? Category { get; set; }

    /// <summary>Derivado de título/descrição (<see cref="UrgentRule"/>); persistido para consultas e eventos.</summary>
    public bool IsUrgent { get; set; }

    /// <summary>Incrementa a cada mudança de estado. Usado pelos consumidores externos para ordenar/deduplicar.</summary>
    public long Version { get; set; }

    /// <summary>Cursor de sincronização por usuário (monotônico, ver <see cref="User.SyncSeq"/>).</summary>
    public long ServerSeq { get; set; }

    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }

    /// <summary>Tombstone: a remoção é lógica para poder ser propagada aos outros dispositivos.</summary>
    public long? DeletedAt { get; set; }

    public Dictionary<string, long> FieldTimes { get; set; } = new();

    public bool IsDeleted => DeletedAt is not null;
}
