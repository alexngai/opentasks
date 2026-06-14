#!/usr/bin/env python3
"""
SigV4 signing reverse-proxy shim for Amazon Bedrock Mantle (OpenAI path).

LiteLLM's `bedrock_mantle/` provider hits the correct endpoint
(https://bedrock-mantle.{region}.api.aws/v1/chat/completions) but only knows how
to authenticate with a static Bearer token (BEDROCK_MANTLE_API_KEY). We don't
have a Mantle bearer key -- we only have AWS SigV4 credentials. This shim sits in
between: it accepts the plain OpenAI request LiteLLM sends, re-signs it with
SigV4 (service name "bedrock", region us-east-1), and forwards to the real Mantle
endpoint. The signed Mantle response is streamed straight back.

Run: python3 sigv4_shim.py            (foreground)
Listens on 127.0.0.1:8787 by default. Forwards /v1/* -> Mantle /v1/*.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import botocore.session
from botocore.awsrequest import AWSRequest
from botocore.auth import SigV4Auth

REGION = os.environ.get("MANTLE_REGION", "us-east-1")
UPSTREAM = f"https://bedrock-mantle.{REGION}.api.aws"
SERVICE = "bedrock"
LISTEN_HOST = os.environ.get("SHIM_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("SHIM_PORT", "8787"))

import urllib.request
import urllib.error

_session = botocore.session.Session()


def _sign_and_forward(path: str, body: bytes) -> tuple[int, dict, bytes]:
    creds = _session.get_credentials().get_frozen_credentials()
    url = UPSTREAM + path
    aws_req = AWSRequest(
        method="POST",
        url=url,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    SigV4Auth(creds, SERVICE, REGION).add_auth(aws_req)
    fwd_headers = dict(aws_req.headers)
    req = urllib.request.Request(url, data=body, headers=fwd_headers, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=300)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[shim] " + (fmt % args) + "\n")

    def do_GET(self):
        # health
        if self.path in ("/health", "/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        try:
            status, headers, payload = _sign_and_forward(self.path, body)
        except Exception as e:  # noqa
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
            return
        self.send_response(status)
        ctype = headers.get("Content-Type", "application/json")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    sys.stderr.write(f"[shim] listening on http://{LISTEN_HOST}:{LISTEN_PORT} -> {UPSTREAM}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
