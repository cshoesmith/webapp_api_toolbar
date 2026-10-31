class HTTPAdapter:
    def __init__(self, max_retries=None):
        self.max_retries = max_retries
