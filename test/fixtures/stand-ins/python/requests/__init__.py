"""A stand-in for the parts of requests that generated scripts use, built on the
standard library so they can run on a machine without requests installed. It is
only placed on the path when the real package is missing."""
import http.client
import http.cookiejar
import json as json_module
import urllib.error
import urllib.parse
import urllib.request


class CaseInsensitiveHeaders(dict):
    def __init__(self, pairs):
        super().__init__()
        self._lower = {}
        for name, value in pairs:
            self[name] = value
            self._lower[name.lower()] = value

    def get(self, name, default=None):
        return self._lower.get(name.lower(), default)


class Response:
    def __init__(self, status, headers, content):
        self.status_code = status
        self.headers = CaseInsensitiveHeaders(headers)
        self.content = content
        self.encoding = "utf-8"

    @property
    def text(self):
        return self.content.decode(self.encoding, "replace")

    def json(self):
        return json_module.loads(self.content)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class CookieJar(http.cookiejar.CookieJar):
    def set(self, name, value, domain, path):
        self.set_cookie(http.cookiejar.Cookie(
            0, name, value, None, False, domain, False, False, path, True,
            False, None, True, None, None, {},
        ))


class Session:
    def __init__(self):
        self.cookies = CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies), _NoRedirect()
        )

    def mount(self, prefix, adapter):
        pass

    def request(self, method, url, allow_redirects=True, timeout=None, headers=None,
                json=None, data=None):
        headers = dict(headers or {})
        if json is not None:
            data = json_module.dumps(json).encode("utf-8")
        elif isinstance(data, list):
            data = urllib.parse.urlencode(data).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method)
        for name, value in headers.items():
            request.add_header(name, value)
        result = self._send(self._opener, request, timeout)
        return Response(result[0], result[1], result[2])

    @staticmethod
    def _send(opener, request, timeout):
        try:
            with opener.open(request, timeout=timeout) as reply:
                return reply.status, reply.getheaders(), reply.read(), reply
        except urllib.error.HTTPError as error:
            return error.code, error.headers.items(), error.read(), error
