from __future__ import annotations

import argparse
import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .circuit import CircuitBuildError
from .contract import RUNNERS, ContractError, parse_run_request
from .runners import RunnerUnavailable, load_qiskit, select_runner


class QiskitBackendHandler(BaseHTTPRequestHandler):
    server_version = "qni-qiskit-backend/0.1"

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib hook
        self.send_response(HTTPStatus.NO_CONTENT.value)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook
        if self.path == "/health":
            self.write_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "defaultRunner": self.default_runner,
                    "runners": sorted(self.allowed_runners),
                },
            )
            return
        self.write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook
        if self.path != "/run":
            self.write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        try:
            self.require_proxy_token()
            payload = self.read_json_body()
            request = parse_run_request(
                payload,
                default_runner=self.default_runner,
                allowed_runners=self.allowed_runners,
            )
            result = select_runner(request.runner).run(request)
        except (CircuitBuildError, ContractError) as exc:
            self.write_json(HTTPStatus.BAD_REQUEST, {"error": "bad_request", "message": str(exc)})
            return
        except RunnerUnavailable as exc:
            self.write_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "runner_unavailable", "message": str(exc)},
            )
            return
        except Exception as exc:  # pragma: no cover - defensive server boundary
            self.write_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "internal_error", "message": str(exc)},
            )
            return
        self.write_json(HTTPStatus.OK, result)

    @property
    def default_runner(self) -> str:
        return getattr(self.server, "default_runner", "mock")

    @property
    def allowed_runners(self) -> frozenset[str]:
        return getattr(self.server, "allowed_runners", RUNNERS)

    @property
    def proxy_token(self) -> str:
        return getattr(self.server, "proxy_token", "")

    def require_proxy_token(self) -> None:
        token = self.proxy_token
        if token and self.headers.get("x-qni-backend-token") != token:
            raise ContractError("missing or invalid backend proxy token")

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ContractError("request body must be a JSON object")
        return payload

    def write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status.value)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        if os.environ.get("QNI_QISKIT_BACKEND_LOG"):
            super().log_message(format, *args)


class QiskitBackendServer(ThreadingHTTPServer):
    default_runner: str
    allowed_runners: frozenset[str]
    proxy_token: str


def parse_allowed_runners(raw: str) -> frozenset[str]:
    names = frozenset(name.strip() for name in raw.split(",") if name.strip())
    if not names:
        raise argparse.ArgumentTypeError("at least one runner must be allowed")
    unknown = sorted(names - RUNNERS)
    if unknown:
        raise argparse.ArgumentTypeError(f"unknown runner: {', '.join(unknown)}")
    return names


def make_server(
    host: str,
    port: int,
    default_runner: str,
    allowed_runners: frozenset[str] = RUNNERS,
    proxy_token: str = "",
) -> QiskitBackendServer:
    if default_runner not in allowed_runners:
        raise ValueError("default runner must be one of the allowed runners")
    # qiskit の初回読み込みはワーカースレッドで行うと次のシミュレーションが
    # SIGSEGV で落ちる。リクエストを受ける前に main スレッドで済ませておく。
    # qiskit が入っていない環境ではサーバ自体は起動させ、実行要求の時点で
    # 従来どおりランナー利用不可のエラーを返す。
    if any(name.startswith("qiskit-") for name in allowed_runners):
        try:
            load_qiskit()
        except RunnerUnavailable:
            pass
    server = QiskitBackendServer((host, port), QiskitBackendHandler)
    server.default_runner = default_runner
    server.allowed_runners = allowed_runners
    server.proxy_token = proxy_token
    return server


def read_proxy_token(raw_token: str, token_file: str) -> str:
    if not token_file:
        return raw_token
    with open(token_file, encoding="utf-8") as handle:
        return handle.read().strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QNI local Qiskit backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=4184, type=int)
    parser.add_argument(
        "--runner",
        default=os.environ.get("QNI_QISKIT_RUNNER", "mock"),
        choices=sorted(RUNNERS),
        help="default runner for requests that omit runner",
    )
    parser.add_argument(
        "--allowed-runners",
        default=os.environ.get("QNI_QISKIT_ALLOWED_RUNNERS", ",".join(sorted(RUNNERS))),
        type=parse_allowed_runners,
        help="comma-separated runners accepted from request payloads",
    )
    parser.add_argument(
        "--proxy-token",
        default=os.environ.get("QNI_BACKEND_PROXY_TOKEN", ""),
        help="optional token required in the x-qni-backend-token header for /run",
    )
    parser.add_argument(
        "--proxy-token-file",
        default=os.environ.get("QNI_BACKEND_PROXY_TOKEN_FILE", ""),
        help="path to a file containing the optional /run proxy token",
    )
    args = parser.parse_args(argv)
    if args.runner not in args.allowed_runners:
        parser.error("--runner must be included in --allowed-runners")
    proxy_token = read_proxy_token(args.proxy_token, args.proxy_token_file)
    server = make_server(args.host, args.port, args.runner, args.allowed_runners, proxy_token)
    print(
        "qni qiskit backend listening on "
        f"http://{args.host}:{args.port} runner={args.runner} "
        f"allowed={','.join(sorted(args.allowed_runners))}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
