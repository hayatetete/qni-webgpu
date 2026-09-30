# Tech Stack

このプロジェクトは **Rust を中心にしたモノレポ** で、用途ごとに Web / TUI / Qiskit backend を持ちます。

- **Web PoC**: ブラウザ上で動く量子回路 UI
- **TUI PoC**: ターミナル上で動く確認用 UI
- **Qiskit backend**: 外部 GPU 実行パスを受けるローカル API

## 全体像

- リポジトリ構成: **monorepo**
- 主言語: **Rust** / **TypeScript** / **Python**
- Rust toolchain: **stable** (`rust-toolchain.toml`)
- Web 向けビルド: **Rust → WebAssembly**
- Node パッケージ管理: **pnpm**
- CI: **GitHub Actions**

## アプリごとの技術スタック

### 1. `apps/web` — Web フロントエンド

ブラウザで動く WebGPU PoC です。

- 言語: **Rust 2021**
- UI: **egui / eframe**
- GPU API: **wgpu**（**WebGPU** バックエンド）
- 配布形態: **WebAssembly (`wasm32-unknown-unknown`)**
- ビルド/開発サーバ: **Trunk**
- ブラウザ側の起動補助: **TypeScript source の `bootstrap.ts`**（Trunk hook で browser module `bootstrap.js` へ生成）
- テスト: **Playwright + Chromium**

要するに、一般的な React/Vue ベースの Web アプリではなく、**Rust で書いた egui アプリを Wasm としてブラウザ上で動かし、描画と状態計算に WebGPU を使う構成**です。

主な依存関係:

- `eframe = 0.33.3`
- `wgpu = 27.0.1`
- `wasm-bindgen`
- `web-sys`
- `@playwright/test = 1.57.0`

### 2. `apps/tui` — ターミナル UI

Web 版とは別に、ローカルで素早く確認できる TUI PoC です。

- 言語: **Rust 2021**
- UI: **ratatui**
- 端末入出力: **crossterm**
- テスト: **cargo test** + **insta** + **ratatui-testlib**

主な依存関係:

- `ratatui = 0.26`
- `crossterm = 0.27`
- `insta = 1`

### 3. `apps/qiskit-backend` — Qiskit backend

Web UI の外部 GPU 実行パスを受けるローカル API です。

- 実行環境: **Python 3.10+**
- 量子実行: **Qiskit / Qiskit Aer**
- 実行方式: **`mock` / `qiskit-cpu-dev` / `qiskit-gpu`**
- テスト: **unittest**

主な依存関係:

- `numpy = 1.26.4`
- `qiskit = 2.5.2`
- `qiskit-aer = 0.17.2`
- qiskit / qiskit-aer の読み込みは `runners.load_qiskit()` に集約し、サーバ起動時に main スレッドで一度だけ行う。
  ワーカースレッドで初回の読み込みを行うと、次のシミュレーションが SIGSEGV でプロセスごと落ちる
  (qiskit 2.5.2 + qiskit-aer 0.17.2 + numpy 2.4.6 で再現。回帰テストは
  `apps/qiskit-backend/tests/test_contract.py` の `test_server_survives_repeated_qiskit_runs_in_worker_threads`)。

## 開発・検証ツール

### Rust 側

- `cargo fmt`
- `cargo clippy -- -D warnings`
- `cargo test`
- `cargo audit`
- `cargo deny`

### Web 側

- `trunk serve`
- `pnpm exec playwright test`
- WebAssembly target: `wasm32-unknown-unknown`

### Qiskit backend 側

- `PYTHONPATH=apps/qiskit-backend/src python3 -m unittest discover apps/qiskit-backend/tests`
- editable install smoke

### CI

GitHub Actions では以下を使って検証します。

- **Node.js 22** (`cucumber.ts` を読み込むために、型注釈を実行時に取り除ける 22.18 以降が必要)
- **pnpm 9**
- **Rust stable**
- **Python 3**
- **trunk**
- **Playwright Chromium**

補足:

- ローカル手動起動は通常の Chrome で行う。WebGPU 用の特別な起動フラグは不要
- ローカル Linux や Playwright MCP の運用では **xvfb-run** を使うことがある
- CI/headless の Playwright 経路では安定化用の Chromium 起動設定を使う

## 実際のビルド/実行単位

- Web UI を動かす: `apps/web`
- TUI を動かす: `apps/tui`
- Qiskit backend を動かす: `apps/qiskit-backend`
- 全体チェック: `./scripts/check-all.sh`

## ひとことで言うと

このプロジェクトは、**Rust を中心に、Web は egui + wgpu + WebAssembly + Trunk、TUI は ratatui、外部 GPU 実行は Python 製 Qiskit backend で構成されたモノレポ**です。
