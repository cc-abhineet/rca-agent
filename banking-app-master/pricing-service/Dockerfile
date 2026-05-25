# Build stage — matches banking-app Dockerfile exactly
FROM maven:3.9.6-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -q
COPY src ./src
RUN mvn package -DskipTests -q

# Runtime stage
FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
COPY --from=build /app/target/pricing-service-2.1.0.jar pricing-service.jar
RUN mkdir -p /var/log/pricing-service
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "/app/pricing-service.jar"]
