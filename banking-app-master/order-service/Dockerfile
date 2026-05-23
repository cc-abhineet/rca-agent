# ── Build stage ─────────────────────────────────────────────────────────────
FROM maven:3.9.6-eclipse-temurin-17 AS build

WORKDIR /app
COPY pom.xml .
# Download dependencies in a separate layer for better caching
RUN mvn dependency:go-offline -q

COPY src ./src
RUN mvn package -DskipTests -q

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM eclipse-temurin:17-jre-jammy

WORKDIR /app

# Create log directory (Logback writes app.log here; Datadog agent sidecar ships it)
RUN mkdir -p /var/log/order-service

COPY --from=build /app/target/order-service-*.jar order-service.jar

EXPOSE 8082

ENTRYPOINT ["java", "-jar", "order-service.jar"]
