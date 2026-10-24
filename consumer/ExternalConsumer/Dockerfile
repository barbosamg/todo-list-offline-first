# Contexto de build: consumer/ExternalConsumer
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY ExternalConsumer.csproj ./
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app ./
EXPOSE 8080
ENTRYPOINT ["dotnet", "ExternalConsumer.dll"]
