class RealCICDAdapter:
    """
    Stub — implement with your proprietary CI/CD system's API.
    Must return DeploymentRecord objects matching CICDAdapterProtocol.
    Required fields: branch, commit_sha, status.
    Optional but valuable: github_repo, commit_message, deployer.
    """

    def get_recent_deployments(
        self, service_name, environment, since, limit=5
    ):
        # TODO: call your CI/CD system's API here
        raise NotImplementedError("RealCICDAdapter not yet implemented")
