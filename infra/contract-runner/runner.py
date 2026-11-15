#!/usr/bin/env python3
"""Contract test runner (M4-06): runs Schemathesis against an API version's sandbox, through the
gateway, when the portal sends the version to review.

Internal network only, bearer RID_CONTRACT_RUNNER_TOKEN:
  GET  /health      liveness, no token
  POST /v1/runs     {"openapi": {...}, "baseUrl": "...", "headers": {...},
                     "maxExamples": 20, "timeoutSeconds": 120}
                    -> {"status": "passed" | "failed" | "error", "operations": [...],
                        "durationMs": ..., "schemathesis": "<version>"}

Only what the portal may keep comes back: per operation, whether it passed, the Schemathesis
check codes that failed (ST101...) and the status code received. Never a request or response
body, a curl command or any header value (CLAUDE.md, rule 2).
"""
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version

TOKEN = os.environ.get("RID_CONTRACT_RUNNER_TOKEN", "")
PORT = int(os.environ.get("RID_CONTRACT_RUNNER_PORT", "8096"))
ST = os.environ.get("RID_SCHEMATHESIS_BIN", "st")
MAX_BODY = 4_000_000
CODE = re.compile(r"\bST\d{3}\b")
RECEIVED = re.compile(r"Received:\s*(\d{3})")
CHECKS = "not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance"


def log(*args):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), *args, file=sys.stderr, flush=True)


def parse_junit(path):
    """Operations and their failures, without anything Schemathesis copied from the traffic."""
    with open(path, "rb") as f:
        raw = f.read()
    # Schemathesis writes it here, but bodies of the sandbox end up inside: no DTD, so no entity
    # expansion of any kind (expat never fetches external entities).
    if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
        raise ValueError("unexpected DTD in the JUnit report")
    root = ET.fromstring(raw)
    operations = []
    for case in root.iter("testcase"):
        failure = case.find("failure")
        error = case.find("error")
        text = (failure.text or "") if failure is not None else ""
        message = (failure.get("message") or "") if failure is not None else ""
        received = RECEIVED.search(text)
        operations.append(
            {
                "operation": (case.get("name") or "")[:200],
                "passed": failure is None and error is None,
                "codes": sorted(set(CODE.findall(message)) | set(CODE.findall(text)))[:20],
                "receivedStatus": int(received.group(1)) if received else None,
            }
        )
    return operations


def run(spec, base_url, headers, max_examples, timeout):
    work = tempfile.mkdtemp(prefix="rid-contract-")
    try:
        spec_path = os.path.join(work, "openapi.json")
        with open(spec_path, "w", encoding="utf-8") as f:
            json.dump(spec, f)
        command = [
            ST, "run", spec_path,
            "--url", base_url,
            "--max-examples", str(max_examples),
            "--phases", "examples,fuzzing",
            "--checks", CHECKS,
            "--report", "junit",
            "--report-dir", work,
            "--request-timeout", "10",
            # Never follow a redirect of the sandbox: it would carry the check token elsewhere.
            "--max-redirects", "0",
            "--seed", "1",
        ]
        for name, value in headers.items():
            command += ["--header", f"{name}: {value}"]
        started = time.monotonic()
        try:
            done = subprocess.run(
                command,
                capture_output=True,
                timeout=timeout,
                env={**os.environ, "PYTHONIOENCODING": "utf-8", "NO_COLOR": "1"},
            )
        except subprocess.TimeoutExpired:
            return {"status": "error", "reason": "timeout", "operations": []}
        duration = int((time.monotonic() - started) * 1000)
        reports = [p for p in os.listdir(work) if p.startswith("junit") and p.endswith(".xml")]
        if not reports:
            # Schemathesis did not get to test (bad schema, unreachable sandbox): the exit code only.
            return {"status": "error", "reason": f"exit {done.returncode}", "operations": [],
                    "durationMs": duration}
        operations = parse_junit(os.path.join(work, reports[0]))
        failed = any(not op["passed"] for op in operations)
        return {
            "status": "failed" if failed else ("passed" if operations else "error"),
            **({} if operations else {"reason": "no operations tested"}),
            "operations": operations,
            "durationMs": duration,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # no request lines with paths or headers
        return

    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        given = self.headers.get("authorization", "").removeprefix("Bearer ")
        return bool(TOKEN) and hmac.compare_digest(given.encode(), TOKEN.encode())

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, {"status": "ok"})
        return self.send(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorized():
            return self.send(401, {"error": "unauthorized"})
        if self.path != "/v1/runs":
            return self.send(404, {"error": "not found"})
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > MAX_BODY:
            return self.send(413, {"error": "body too large or empty"})
        try:
            body = json.loads(self.rfile.read(length))
            spec = body["openapi"]
            base_url = str(body["baseUrl"])
            headers = {str(k): str(v) for k, v in (body.get("headers") or {}).items()}
            max_examples = min(max(int(body.get("maxExamples", 20)), 1), 200)
            timeout = min(max(int(body.get("timeoutSeconds", 120)), 10), 600)
            if not isinstance(spec, dict) or not re.match(r"^https?://", base_url):
                raise ValueError("openapi must be an object and baseUrl an http(s) URL")
        except (KeyError, ValueError, TypeError, json.JSONDecodeError) as error:
            return self.send(400, {"error": str(error)[:200]})
        result = run(spec, base_url, headers, max_examples, timeout)
        log(f"run: {result['status']}, {len(result['operations'])} operations")
        return self.send(200, {**result, "schemathesis": version("schemathesis")})


if __name__ == "__main__":
    if len(TOKEN) < 16:
        sys.exit("RID_CONTRACT_RUNNER_TOKEN must be set (16+ characters)")
    log(f"contract runner on :{PORT}, schemathesis {version('schemathesis')}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
