class DatadogAdapter:
    """
    Stub — fill in with Datadog API calls.
    Docs: https://docs.datadoghq.com/api/latest/logs/#search-logs
    """

    def get_error_log(self, error_id: str):
        # TODO: GET https://api.datadoghq.com/api/v2/logs/events/{error_id}
        raise NotImplementedError("DatadogAdapter.get_error_log not yet implemented")

    def get_service_metadata(self, service_name: str) -> dict:
        # TODO: GET https://api.datadoghq.com/api/v2/services/{service_name}
        raise NotImplementedError("DatadogAdapter.get_service_metadata not yet implemented")
