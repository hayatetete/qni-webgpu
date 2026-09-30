# syntax=docker/dockerfile:1.7

FROM nvidia/cuda:12.6.1-devel-ubuntu22.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive
ENV CUQUANTUM_ROOT=/opt/nvidia/cuquantum
ENV LD_LIBRARY_PATH=${CUQUANTUM_ROOT}/lib:${LD_LIBRARY_PATH}
ENV PATH=/root/.cargo/bin:${PATH}
ENV QNI_HTTP_PORT=8000
ENV QNI_WEB_ROOT=/opt/qni-webgpu/apps/web/dist
ENV QNI_QISKIT_BACKEND_HOST=127.0.0.1
ENV QNI_QISKIT_BACKEND_PORT=4184
ENV QNI_QISKIT_RUNNER=qiskit-gpu
ENV QNI_QISKIT_ALLOWED_RUNNERS=qiskit-gpu

RUN apt-get update && \
  apt-get install -y --no-install-recommends \
    apache2-utils \
    binaryen \
    build-essential \
    ca-certificates \
    clang \
    cmake \
    curl \
    gettext-base \
    git \
    gnupg \
    libopenblas-dev \
    libssl-dev \
    nginx \
    pkg-config \
    python3 \
    python3-dev \
    python3-pip \
    python3-skbuild \
    python3-venv \
    wget && \
  rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
  apt-get update && \
  apt-get install -y --no-install-recommends nodejs && \
  npm install -g pnpm@9.15.9 && \
  rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --profile minimal && \
  rustup target add wasm32-unknown-unknown && \
  cargo install trunk --locked

RUN wget -q https://developer.download.nvidia.com/compute/cuquantum/24.08.0/local_installers/cuquantum-local-repo-ubuntu2204-24.08.0_24.08.0-1_amd64.deb && \
  dpkg -i cuquantum-local-repo-ubuntu2204-24.08.0_24.08.0-1_amd64.deb && \
  cp /var/cuquantum-local-repo-ubuntu2204-24.08.0/cuquantum-*-keyring.gpg /usr/share/keyrings/ && \
  wget -q https://developer.download.nvidia.com/compute/cutensor/2.0.2.1/local_installers/cutensor-local-repo-ubuntu2204-2.0.2_1.0-1_amd64.deb && \
  dpkg -i cutensor-local-repo-ubuntu2204-2.0.2_1.0-1_amd64.deb && \
  cp /var/cutensor-local-repo-ubuntu2204-2.0.2/cutensor-*-keyring.gpg /usr/share/keyrings/ && \
  apt-get update && \
  apt-get install -y --no-install-recommends \
    cuquantum-cuda-12 \
    libcutensor1 \
    libcutensor2 \
    libcutensor-dev && \
  rm -f cuquantum-local-repo-ubuntu2204-24.08.0_24.08.0-1_amd64.deb \
    cutensor-local-repo-ubuntu2204-2.0.2_1.0-1_amd64.deb && \
  rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel && \
  python3 -m pip install --no-cache-dir \
    bottle \
    colorama \
    'conan<2.0' \
    distro \
    fasteners \
    hatch \
    node-semver \
    patch-ng \
    pluginbase \
    pybind11 \
    PyJWT \
    'numpy>=2.0,<3' \
    'qiskit==2.5.2' && \
  git clone --depth 1 -b 0.17.2 https://github.com/Qiskit/qiskit-aer.git /tmp/qiskit-aer && \
  cd /tmp/qiskit-aer && \
  python3 ./setup.py bdist_wheel -- \
    -DAER_THRUST_BACKEND=CUDA \
    -DAER_PYTHON_CUDA_ROOT=qiskit-aer-venv && \
  python3 -m pip install --no-cache-dir dist/qiskit_aer-*.whl && \
  rm -rf /tmp/qiskit-aer /root/.cache/pip

WORKDIR /opt/qni-webgpu
COPY . /opt/qni-webgpu
COPY deploy/docker/nginx.conf.template /etc/qni-webgpu/nginx.conf.template
COPY --chmod=755 deploy/docker/docker-entrypoint.sh /usr/local/bin/qni-webgpu-entrypoint

RUN python3 -m pip install --no-cache-dir --no-deps -e apps/qiskit-backend && \
  cd apps/web && \
  pnpm install --frozen-lockfile && \
  trunk build --release --public-url ./ && \
  pnpm store prune && \
  rm -rf /root/.cargo/registry /root/.cargo/git /root/.cache /var/cache/apt/archives

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD curl -fsS "http://127.0.0.1:${QNI_HTTP_PORT:-8000}/health" >/dev/null || exit 1

ENTRYPOINT ["qni-webgpu-entrypoint"]
CMD ["nginx"]
