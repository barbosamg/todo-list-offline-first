using FluentAssertions;
using TodoOffline.Api.Infrastructure;

namespace TodoOffline.Tests.Auth;

public class PasswordHasherTests
{
    [Fact]
    public void Verifies_the_correct_password()
    {
        var hash = PasswordHasher.Hash("Senha@123");
        PasswordHasher.Verify("Senha@123", hash).Should().BeTrue();
    }

    [Fact]
    public void Rejects_a_wrong_password()
    {
        var hash = PasswordHasher.Hash("Senha@123");
        PasswordHasher.Verify("senha@123", hash).Should().BeFalse();
        PasswordHasher.Verify("", hash).Should().BeFalse();
    }

    [Fact]
    public void Same_password_produces_different_hashes_because_of_the_random_salt()
    {
        PasswordHasher.Hash("igual").Should().NotBe(PasswordHasher.Hash("igual"));
    }

    [Fact]
    public void Hash_has_the_versioned_format_and_never_contains_the_password()
    {
        var hash = PasswordHasher.Hash("segredo-que-nao-deve-aparecer");
        hash.Should().StartWith("v1.120000.").And.NotContain("segredo");
        hash.Split('.').Should().HaveCount(4);
    }

    [Theory]
    [InlineData("")]
    [InlineData("lixo")]
    [InlineData("v2.1.AA==.AA==")]
    [InlineData("v1.abc.AA==.AA==")]
    [InlineData("v1.1.AA==")]
    public void Malformed_stored_hash_is_rejected_without_throwing(string stored)
    {
        PasswordHasher.Verify("qualquer", stored).Should().BeFalse();
    }

    [Fact]
    public void Handles_unicode_passwords()
    {
        var hash = PasswordHasher.Hash("sênha-çom-açéntôs-🔒");
        PasswordHasher.Verify("sênha-çom-açéntôs-🔒", hash).Should().BeTrue();
        PasswordHasher.Verify("senha-com-acentos-🔒", hash).Should().BeFalse();
    }
}
