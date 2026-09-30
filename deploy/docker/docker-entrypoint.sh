#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${QNI_HTTP_PORT:=8000}"
: "${QNI_WEB_ROOT:=/opt/qni-webgpu/apps/web/dist}"
: "${QNI_QISKIT_BACKEND_HOST:=127.0.0.1}"
: "${QNI_QISKIT_BACKEND_PORT:=4184}"
: "${QNI_QISKIT_RUNNER:=qiskit-gpu}"
: "${QNI_QISKIT_ALLOWED_RUNNERS:=qiskit-gpu}"
: "${QNI_REQUIRE_BASIC_AUTH:=false}"
# nginx 設定テンプレートの位置。既定はコンテナ内の配置先で、テストからは
# リポジトリ内のテンプレートを指すために上書きする。
: "${QNI_NGINX_TEMPLATE:=/etc/qni-webgpu/nginx.conf.template}"

if [[ "${QNI_QISKIT_RUNNER}" != "qiskit-gpu" ]]; then
  echo "QNI_QISKIT_RUNNER must be qiskit-gpu in the production container" >&2
  exit 1
fi

if [[ "${QNI_QISKIT_ALLOWED_RUNNERS}" != "qiskit-gpu" ]]; then
  echo "QNI_QISKIT_ALLOWED_RUNNERS must be qiskit-gpu in the production container" >&2
  exit 1
fi

if [[ -n "${QNI_RUNTIME_DIR:-}" ]]; then
  mkdir -p "${QNI_RUNTIME_DIR}"
else
  QNI_RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qni-webgpu-runtime.XXXXXX")"
fi
chmod 700 "${QNI_RUNTIME_DIR}"
mkdir -p "${QNI_RUNTIME_DIR}" \
  "${QNI_RUNTIME_DIR}/client_temp" \
  "${QNI_RUNTIME_DIR}/proxy_temp" \
  "${QNI_RUNTIME_DIR}/fastcgi_temp" \
  "${QNI_RUNTIME_DIR}/uwsgi_temp" \
  "${QNI_RUNTIME_DIR}/scgi_temp"

QNI_AUTH_SNIPPET="${QNI_RUNTIME_DIR}/qni-auth.conf"
HTPASSWD_FILE="${QNI_RUNTIME_DIR}/.htpasswd"
BACKEND_TOKEN_FILE="${QNI_RUNTIME_DIR}/backend-token"
SERVER_CONF="${QNI_RUNTIME_DIR}/server.conf"
NGINX_CONF="${QNI_RUNTIME_DIR}/nginx.conf"
: > "${QNI_AUTH_SNIPPET}"

if [[ -n "${QNI_AUTH_HTPASSWD_FILE:-}" ]]; then
  if [[ ! -f "${QNI_AUTH_HTPASSWD_FILE}" ]]; then
    echo "QNI_AUTH_HTPASSWD_FILE does not exist: ${QNI_AUTH_HTPASSWD_FILE}" >&2
    exit 1
  fi
  cp "${QNI_AUTH_HTPASSWD_FILE}" "${HTPASSWD_FILE}"
  chmod 600 "${HTPASSWD_FILE}"
elif [[ -n "${QNI_AUTH_USERNAME:-}" || -n "${QNI_AUTH_PASSWORD:-}" || -n "${QNI_AUTH_PASSWORD_FILE:-}" ]]; then
  if [[ -z "${QNI_AUTH_USERNAME:-}" ]]; then
    echo "QNI_AUTH_USERNAME must be set when password authentication is configured" >&2
    exit 1
  fi
  if [[ -n "${QNI_AUTH_PASSWORD:-}" && -n "${QNI_AUTH_PASSWORD_FILE:-}" ]]; then
    echo "Set only one of QNI_AUTH_PASSWORD or QNI_AUTH_PASSWORD_FILE" >&2
    exit 1
  fi
  if [[ -n "${QNI_AUTH_PASSWORD_FILE:-}" ]]; then
    if [[ ! -f "${QNI_AUTH_PASSWORD_FILE}" ]]; then
      echo "QNI_AUTH_PASSWORD_FILE does not exist: ${QNI_AUTH_PASSWORD_FILE}" >&2
      exit 1
    fi
    auth_password="$(<"${QNI_AUTH_PASSWORD_FILE}")"
  elif [[ -n "${QNI_AUTH_PASSWORD:-}" ]]; then
    auth_password="${QNI_AUTH_PASSWORD}"
  else
    echo "QNI_AUTH_PASSWORD or QNI_AUTH_PASSWORD_FILE must be set with QNI_AUTH_USERNAME" >&2
    exit 1
  fi
  printf '%s\n' "${auth_password}" | htpasswd -Bci "${HTPASSWD_FILE}" "${QNI_AUTH_USERNAME}" >/dev/null
  chmod 600 "${HTPASSWD_FILE}"
  unset auth_password QNI_AUTH_PASSWORD
elif [[ "${QNI_REQUIRE_BASIC_AUTH}" == "true" ]]; then
  echo "Basic authentication is required, but no htpasswd source was provided" >&2
  exit 1
fi

if [[ -f "${HTPASSWD_FILE}" ]]; then
  cat > "${QNI_AUTH_SNIPPET}" <<EOS
auth_basic "Restricted";
auth_basic_user_file ${HTPASSWD_FILE};
EOS
fi
chmod 600 "${QNI_AUTH_SNIPPET}"

if [[ -n "${QNI_BACKEND_PROXY_TOKEN_FILE:-}" ]]; then
  if [[ ! -f "${QNI_BACKEND_PROXY_TOKEN_FILE}" ]]; then
    echo "QNI_BACKEND_PROXY_TOKEN_FILE does not exist: ${QNI_BACKEND_PROXY_TOKEN_FILE}" >&2
    exit 1
  fi
  QNI_BACKEND_PROXY_TOKEN="$(<"${QNI_BACKEND_PROXY_TOKEN_FILE}")"
elif [[ -z "${QNI_BACKEND_PROXY_TOKEN:-}" ]]; then
  QNI_BACKEND_PROXY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
fi
printf '%s\n' "${QNI_BACKEND_PROXY_TOKEN}" > "${BACKEND_TOKEN_FILE}"
chmod 600 "${BACKEND_TOKEN_FILE}"

export QNI_HTTP_PORT QNI_WEB_ROOT QNI_QISKIT_BACKEND_HOST QNI_QISKIT_BACKEND_PORT QNI_AUTH_SNIPPET QNI_BACKEND_PROXY_TOKEN
envsubst '${QNI_HTTP_PORT} ${QNI_WEB_ROOT} ${QNI_QISKIT_BACKEND_HOST} ${QNI_QISKIT_BACKEND_PORT} ${QNI_AUTH_SNIPPET} ${QNI_BACKEND_PROXY_TOKEN}' \
  < "${QNI_NGINX_TEMPLATE}" \
  > "${SERVER_CONF}"
chmod 600 "${SERVER_CONF}"
unset QNI_BACKEND_PROXY_TOKEN

NGINX_USER_DIRECTIVE=""
if [[ "$(id -u)" -eq 0 ]]; then
  NGINX_USER_DIRECTIVE="user root;"
fi
cat > "${NGINX_CONF}" <<EOS
${NGINX_USER_DIRECTIVE}
pid ${QNI_RUNTIME_DIR}/nginx.pid;
error_log /dev/stderr info;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log /dev/stdout;
  sendfile on;
  keepalive_timeout 65;
  client_body_temp_path ${QNI_RUNTIME_DIR}/client_temp;
  proxy_temp_path ${QNI_RUNTIME_DIR}/proxy_temp;
  fastcgi_temp_path ${QNI_RUNTIME_DIR}/fastcgi_temp;
  uwsgi_temp_path ${QNI_RUNTIME_DIR}/uwsgi_temp;
  scgi_temp_path ${QNI_RUNTIME_DIR}/scgi_temp;
  include ${SERVER_CONF};
}
EOS
chmod 600 "${NGINX_CONF}"
nginx -c "${NGINX_CONF}" -t

export PYTHONPATH=/opt/qni-webgpu/apps/qiskit-backend/src
QNI_BACKEND_PROXY_TOKEN_FILE="${BACKEND_TOKEN_FILE}" \
python3 -m qni_qiskit_backend \
  --host "${QNI_QISKIT_BACKEND_HOST}" \
  --port "${QNI_QISKIT_BACKEND_PORT}" \
  --runner qiskit-gpu \
  --allowed-runners qiskit-gpu &
backend_pid=$!

cleanup() {
  kill "${backend_pid}" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://${QNI_QISKIT_BACKEND_HOST}:${QNI_QISKIT_BACKEND_PORT}/health" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://${QNI_QISKIT_BACKEND_HOST}:${QNI_QISKIT_BACKEND_PORT}/health" >/dev/null; then
  echo "Qiskit backend did not become healthy" >&2
  exit 1
fi

if [[ $# -eq 0 || "${1}" == "nginx" ]]; then
  exec nginx -c "${NGINX_CONF}" -g "daemon off;"
fi

exec "$@"
