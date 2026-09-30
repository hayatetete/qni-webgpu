# qni Qiskit backend

Local development backend for the web external GPU execution path.

Python と Qiskit のバージョンは `pyproject.toml` で固定する。値の一覧は `docs/tech-stack.md` を参照する。

## Runners

- `mock`: fixed histogram response and fixed ground-state Amplitude / Bloch / Probability / Density Matrix display payloads. No quantum simulation; useful for UI/API smoke tests.
- `qiskit-cpu-dev`: explicit local Qiskit CPU runner for checking the Qiskit circuit path on machines without CUDA. This is not a WebGPU fallback and must not be used as the production execution path.
- `qiskit-gpu`: Qiskit Aer statevector runner with `device="GPU"` and `cuStateVec_enable=True`. No CPU fallback.

Production deployment must start the server with `--runner qiskit-gpu --allowed-runners qiskit-gpu` or equivalent `QNI_QISKIT_RUNNER=qiskit-gpu` / `QNI_QISKIT_ALLOWED_RUNNERS=qiskit-gpu` environment variables. With that setting, request payloads that ask for `mock` or `qiskit-cpu-dev` are rejected instead of falling back to CPU.

All runners return bounded histogram output and optional Amplitude / Bloch / Probability / Density Matrix display payloads only. The API accepts 1–32 qubits, rejects full statevector / full probability requests, and currently limits exact Amplitude display extraction to <=16 qubits. Bloch display extraction uses per-axis expectation values when uncontrolled, and controlled Bloch display requests carry `control_mask` / `control_value` for conditional extraction; target plus controls must stay within 8 saved bits. Probability display extraction uses bounded subsystem probability vectors for the requested display span, and controlled Probability display requests carry `control_mask` / `control_value` for conditional extraction; `span + non-display control count` must stay within 16 saved bits. Density Matrix display extraction uses bounded subsystem density matrices for Quirk-compatible span 1–8 displays, and controlled Density Matrix display requests carry `control_mask` / `control_value` for conditional extraction; `span + non-display control count` must stay within 8 saved bits. The web state-vector panel, when refreshed for <=16-qubit GPU-mode runs, is recomputed locally in WebGPU after a successful run rather than transferred from this backend.

## Run

```bash
PYTHONPATH=apps/qiskit-backend/src python3 -m qni_qiskit_backend --port 4184 --runner mock
```

CPU dev runner (requires a Python environment with `qiskit` and `qiskit-aer`):

```bash
PYTHONPATH=apps/qiskit-backend/src python3 -m qni_qiskit_backend --port 4184 --runner qiskit-cpu-dev
```

GPU runner:

```bash
PYTHONPATH=apps/qiskit-backend/src python3 -m qni_qiskit_backend --port 4184 --runner qiskit-gpu
```

Production GPU-only runner:

```bash
QNI_QISKIT_ALLOWED_RUNNERS=qiskit-gpu \
PYTHONPATH=apps/qiskit-backend/src \
python3 -m qni_qiskit_backend --port 4184 --runner qiskit-gpu
```

## API

Health:

```bash
curl http://127.0.0.1:4184/health
```

Run:

```bash
curl -s http://127.0.0.1:4184/run \
  -H 'content-type: application/json' \
  -d '{"runner":"mock","qubits":4,"columns":[["H",1,1,1],["Amps1","Bloch","Probability","Density"]],"shots":128,"outputs":{"histogram":true,"amplitudes":[{"gate_id":2,"column":1,"span":1,"base_bit":3,"control_mask":0,"control_value":0,"phase_lock_enabled":true}],"bloch":[{"gate_id":3,"column":1,"wire":1,"control_mask":0,"control_value":0}],"probability":[{"gate_id":4,"column":1,"span":1,"base_bit":1,"control_mask":0,"control_value":0}],"densities":[{"gate_id":5,"column":1,"span":1,"base_bit":0,"control_mask":0,"control_value":0}]}}'
```

Response shape:

```json
{"status":"completed","runner":"mock","qubits":4,"shots":128,"histogram":{"0000":128},"truncated":false,"amplitudes":[{"gate_id":2,"span":1,"ket":[[1.0,0.0],[0.0,0.0]],"incoherent":[1.0,0.0],"quality":1.0,"phase_lock_index":0}],"bloch":[{"gate_id":3,"vector":[0.0,0.0,1.0]}],"probability":[{"gate_id":4,"span":1,"probabilities":[1.0,0.0]}],"densities":[{"gate_id":5,"span":1,"cells":[[1.0,0.0],[0.0,0.0],[0.0,0.0],[0.0,0.0]],"unity":1.0}]}
```

## Test

```bash
PYTHONPATH=apps/qiskit-backend/src python3 -m unittest discover apps/qiskit-backend/tests
```
