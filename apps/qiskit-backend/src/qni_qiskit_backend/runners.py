from __future__ import annotations

import cmath
import math
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Protocol, Sequence

from .circuit import apply_column_to_qiskit, initial_basis_tracker
from .contract import (
    AmplitudeOutputRequest,
    BlochOutputRequest,
    DensityOutputRequest,
    ProbabilityOutputRequest,
    QubitCount,
    RunRequest,
)


def qubit_value(qubits: int | QubitCount) -> int:
    return qubits.value if isinstance(qubits, QubitCount) else qubits


class RunnerUnavailable(RuntimeError):
    pass


# qiskit / qiskit-aer は任意依存なので遅延読み込みにしている。ただしワーカー
# スレッドで初回の読み込みを行うと、次のシミュレーションが SIGSEGV で落ちる
# (qiskit 2.5.2 + qiskit-aer 0.17.2 + numpy 2.4.6 で再現)。読み込みは必ず
# main スレッドで一度だけ済ませ、以降はキャッシュを使う。
_QISKIT_MODULES: tuple[Any, Any, Any, Any] | None = None


def load_qiskit() -> tuple[Any, Any, Any, Any]:
    global _QISKIT_MODULES
    if _QISKIT_MODULES is not None:
        return _QISKIT_MODULES
    try:
        from qiskit import QuantumCircuit, transpile
        from qiskit.quantum_info import Pauli
        from qiskit_aer import AerSimulator
    except Exception as exc:  # pragma: no cover - depends on local env
        raise RunnerUnavailable(
            "qiskit and qiskit-aer are required for this runner"
        ) from exc
    _QISKIT_MODULES = (QuantumCircuit, transpile, Pauli, AerSimulator)
    return _QISKIT_MODULES


class Runner(Protocol):
    name: str

    def run(self, request: RunRequest) -> dict[str, Any]: ...


@dataclass(frozen=True)
class MockRunner:
    name: str = "mock"

    def run(self, request: RunRequest) -> dict[str, Any]:
        # Transport/UI smoke runner only. It intentionally does not simulate.
        qubits = request.qubits.value
        key = "0" * qubits
        response = histogram_response(
            runner=self.name,
            qubits=qubits,
            shots=request.shots,
            histogram={key: request.shots},
        )
        add_mock_amplitudes(response, request)
        add_mock_bloch(response, request)
        add_mock_probability(response, request)
        add_mock_density(response, request)
        return response


@dataclass(frozen=True)
class QiskitRunner:
    name: str
    device: str
    cu_state_vec: bool = False

    def run(self, request: RunRequest) -> dict[str, Any]:
        QuantumCircuit, transpile, Pauli, AerSimulator = load_qiskit()

        qubits = request.qubits.value
        qc = QuantumCircuit(qubits, qubits)
        amplitude_labels, bloch_labels, probability_labels, density_labels = add_display_saves(
            qc, request, Pauli
        )
        for wire in range(qubits):
            qc.measure(wire, wire)

        options: dict[str, Any] = {"method": "statevector", "device": self.device}
        if self.cu_state_vec:
            options["cuStateVec_enable"] = True
        simulator = AerSimulator(**options)
        transpiled = transpile(qc, simulator)
        try:
            result = simulator.run(
                transpiled,
                shots=request.shots,
                seed_simulator=request.seed,
            ).result()
        except Exception as exc:  # pragma: no cover - depends on local env
            raise RunnerUnavailable(f"{self.name} execution failed: {exc}") from exc

        counts = normalize_qiskit_counts(result.get_counts())
        response = histogram_response(
            runner=self.name,
            qubits=qubits,
            shots=request.shots,
            histogram=counts,
        )
        data = result.data(0)
        add_qiskit_amplitudes(response, request, data, amplitude_labels)
        add_qiskit_bloch(response, request, data, bloch_labels)
        add_qiskit_probability(response, request, data, probability_labels)
        add_qiskit_density(response, request, data, density_labels)
        return response


def select_runner(name: str) -> Runner:
    if name == "mock":
        return MockRunner()
    if name == "qiskit-cpu-dev":
        return QiskitRunner(name="qiskit-cpu-dev", device="CPU")
    if name == "qiskit-gpu":
        return QiskitRunner(name="qiskit-gpu", device="GPU", cu_state_vec=True)
    raise ValueError(f"unknown runner: {name}")


def add_display_saves(
    qc: Any, request: RunRequest, pauli_type: Any
) -> tuple[dict[int, str], dict[int, str | dict[str, str]], dict[int, str], dict[int, str]]:
    amplitudes_by_column: dict[int, list[AmplitudeOutputRequest]] = defaultdict(list)
    bloch_by_column: dict[int, list[BlochOutputRequest]] = defaultdict(list)
    probability_by_column: dict[int, list[ProbabilityOutputRequest]] = defaultdict(list)
    density_by_column: dict[int, list[DensityOutputRequest]] = defaultdict(list)
    for amplitude in request.amplitude_outputs:
        amplitudes_by_column[amplitude.column].append(amplitude)
    for bloch in request.bloch_outputs:
        bloch_by_column[bloch.column].append(bloch)
    for probability in request.probability_outputs:
        probability_by_column[probability.column].append(probability)
    for density in request.density_outputs:
        density_by_column[density.column].append(density)
    amplitude_labels: dict[int, str] = {}
    bloch_labels: dict[int, str | dict[str, str]] = {}
    probability_labels: dict[int, str] = {}
    density_labels: dict[int, str] = {}
    qubits = request.qubits.value
    basis = qiskit_basis_order(qubits) if request.amplitude_outputs else []
    basis_tracker = initial_basis_tracker(qubits)
    for column_index, column in enumerate(request.columns):
        apply_column_to_qiskit(qc, column, qubits, basis_tracker)
        for amplitude in amplitudes_by_column.get(column_index, []):
            label = f"amplitude:{amplitude.gate_id}"
            qc.save_amplitudes(basis, label=label)
            amplitude_labels[amplitude.gate_id] = label
        for bloch in bloch_by_column.get(column_index, []):
            if bloch.control_mask == 0:
                axis_labels: dict[str, str] = {}
                for axis in ("X", "Y", "Z"):
                    label = f"bloch:{bloch.gate_id}:{axis.lower()}"
                    qc.save_expectation_value(pauli_type(axis), [bloch.wire], label=label)
                    axis_labels[axis] = label
                bloch_labels[bloch.gate_id] = axis_labels
            else:
                label = f"bloch:{bloch.gate_id}:density"
                qc.save_density_matrix(bloch_save_qargs(bloch, request.qubits), label=label)
                bloch_labels[bloch.gate_id] = label
        for probability in probability_by_column.get(column_index, []):
            label = f"probability:{probability.gate_id}"
            qc.save_probabilities(probability_save_qargs(probability, qubits), label=label)
            probability_labels[probability.gate_id] = label
        for density in density_by_column.get(column_index, []):
            label = f"density:{density.gate_id}"
            qc.save_density_matrix(density_save_qargs(density, qubits), label=label)
            density_labels[density.gate_id] = label
    return amplitude_labels, bloch_labels, probability_labels, density_labels


def add_qiskit_amplitudes(
    response: dict[str, Any],
    request: RunRequest,
    data: dict[str, Any],
    labels: dict[int, str],
) -> None:
    if not request.amplitude_outputs:
        return
    response["amplitudes"] = [
        amplitude_display_response(
            amplitude,
            qiskit_saved_amplitudes(data[labels[amplitude.gate_id]]),
            request.qubits.value,
        )
        for amplitude in request.amplitude_outputs
    ]


def add_qiskit_bloch(
    response: dict[str, Any],
    request: RunRequest,
    data: dict[str, Any],
    labels: dict[int, str | dict[str, str]],
) -> None:
    if not request.bloch_outputs:
        return
    response["bloch"] = []
    for bloch in request.bloch_outputs:
        label = labels[bloch.gate_id]
        if isinstance(label, dict):
            vector = [
                saved_float(data[label["X"]]),
                saved_float(data[label["Y"]]),
                saved_float(data[label["Z"]]),
            ]
        else:
            vector = controlled_bloch_vector(
                bloch,
                qiskit_saved_density_matrix(data[label]),
                request.qubits,
            )
        response["bloch"].append(bloch_display_response(bloch, vector))


def add_qiskit_probability(
    response: dict[str, Any],
    request: RunRequest,
    data: dict[str, Any],
    labels: dict[int, str],
) -> None:
    if not request.probability_outputs:
        return
    response["probability"] = [
        probability_display_response(
            probability,
            qiskit_saved_probabilities(data[labels[probability.gate_id]]),
            request.qubits,
        )
        for probability in request.probability_outputs
    ]


def add_qiskit_density(
    response: dict[str, Any],
    request: RunRequest,
    data: dict[str, Any],
    labels: dict[int, str],
) -> None:
    if not request.density_outputs:
        return
    response["densities"] = [
        density_display_response(
            density,
            qiskit_saved_density_matrix(data[labels[density.gate_id]]),
            request.qubits.value,
        )
        for density in request.density_outputs
    ]


def add_mock_amplitudes(response: dict[str, Any], request: RunRequest) -> None:
    if not request.amplitude_outputs:
        return
    qubits = request.qubits.value
    state_count = 1 << qubits
    ground_state = [0j] * state_count
    ground_state[0] = 1 + 0j
    response["amplitudes"] = [
        amplitude_display_response(amplitude, ground_state, qubits)
        for amplitude in request.amplitude_outputs
    ]


def add_mock_bloch(response: dict[str, Any], request: RunRequest) -> None:
    if not request.bloch_outputs:
        return
    response["bloch"] = [
        bloch_display_response(bloch, [0.0, 0.0, 1.0])
        for bloch in request.bloch_outputs
    ]


def add_mock_probability(response: dict[str, Any], request: RunRequest) -> None:
    if not request.probability_outputs:
        return
    response["probability"] = [
        probability_display_response(
            probability,
            [1.0]
            + [0.0]
            * ((1 << (probability.span + len(probability_control_bits(probability, request.qubits)))) - 1),
            request.qubits,
        )
        for probability in request.probability_outputs
    ]


def add_mock_density(response: dict[str, Any], request: RunRequest) -> None:
    if not request.density_outputs:
        return
    response["densities"] = [
        density_display_response(
            density,
            ground_density_matrix(
                density.span + len(density_control_bits(density, request.qubits.value))
            ),
            request.qubits.value,
        )
        for density in request.density_outputs
    ]


def bloch_display_response(request: BlochOutputRequest, vector: Sequence[float]) -> dict[str, Any]:
    return {"gate_id": request.gate_id, "vector": [float(value) for value in vector[:3]]}


def controlled_bloch_vector(
    request: BlochOutputRequest, matrix: Sequence[Sequence[complex]], qubits: int | QubitCount
) -> list[float]:
    control_bits = bloch_control_bits(request, qubits)
    row_base = bloch_control_index(request, control_bits) * 2
    rho_00 = complex(matrix[row_base][row_base]).real
    rho_01 = complex(matrix[row_base][row_base + 1])
    rho_11 = complex(matrix[row_base + 1][row_base + 1]).real
    unity = rho_00 + rho_11
    if unity <= 1e-12:
        return [0.0, 0.0, 0.0]
    return [
        2.0 * rho_01.real / unity,
        -2.0 * rho_01.imag / unity,
        (rho_00 - rho_11) / unity,
    ]


def probability_display_response(
    request: ProbabilityOutputRequest, probabilities: Sequence[float], qubits: int | QubitCount
) -> dict[str, Any]:
    qubits = qubit_value(qubits)
    outcomes = 1 << request.span
    control_bits = probability_control_bits(request, qubits)
    control_index = probability_control_index(request, control_bits)
    values: list[float] = []
    unity = 0.0
    for outcome in range(outcomes):
        if probability_display_controls_match(request, outcome):
            value = float(probabilities[control_index * outcomes + outcome])
        else:
            value = 0.0
        values.append(value)
        unity += value
    if unity > 1e-12:
        values = [value / unity for value in values]
    return {
        "gate_id": request.gate_id,
        "span": request.span,
        "probabilities": values,
    }


def density_display_response(
    request: DensityOutputRequest,
    matrix: Sequence[Sequence[complex]],
    qubits: int | QubitCount,
) -> dict[str, Any]:
    qubits = qubit_value(qubits)
    dim = 1 << request.span
    control_bits = density_control_bits(request, qubits)
    control_index = density_control_index(request, control_bits)
    cells: list[list[float]] = []
    unity = 0.0
    for row in range(dim):
        row_matches = density_display_controls_match(request, row)
        row_index = control_index * dim + row
        if row_matches:
            unity += complex(matrix[row_index][row_index]).real
        for col in range(dim):
            col_matches = density_display_controls_match(request, col)
            col_index = control_index * dim + col
            value = complex(matrix[row_index][col_index]) if row_matches and col_matches else 0j
            cells.append([float(value.real), float(value.imag)])
    return {"gate_id": request.gate_id, "span": request.span, "cells": cells, "unity": unity}


def ground_density_matrix(span: int) -> list[list[complex]]:
    dim = 1 << span
    matrix = [[0j for _ in range(dim)] for _ in range(dim)]
    matrix[0][0] = 1 + 0j
    return matrix


def bloch_save_qargs(request: BlochOutputRequest, qubits: int | QubitCount) -> list[int]:
    # q0=LSB: web ビット位置 = wire = Qiskit 量子ビット番号（恒等写像）。
    qubits = qubit_value(qubits)
    return [request.wire] + bloch_control_bits(request, qubits)


def bloch_control_bits(request: BlochOutputRequest, qubits: int | QubitCount) -> list[int]:
    qubits = qubit_value(qubits)
    target_bit = request.wire
    return [
        bit
        for bit in range(qubits)
        if request.control_mask & (1 << bit) and bit != target_bit
    ]


def bloch_control_index(request: BlochOutputRequest, control_bits: Sequence[int]) -> int:
    index = 0
    for offset, bit in enumerate(control_bits):
        if request.control_value & (1 << bit):
            index |= 1 << offset
    return index


def probability_qargs(request: ProbabilityOutputRequest) -> list[int]:
    # q0=LSB: web ビット位置 = Qiskit 量子ビット番号（恒等写像）。
    return list(probability_bits(request))


def probability_save_qargs(request: ProbabilityOutputRequest, qubits: int | QubitCount) -> list[int]:
    qubits = qubit_value(qubits)
    return probability_bits(request) + probability_control_bits(request, qubits)


def probability_bits(request: ProbabilityOutputRequest) -> list[int]:
    return list(range(request.base_bit, request.base_bit + request.span))


def probability_control_bits(request: ProbabilityOutputRequest, qubits: int | QubitCount) -> list[int]:
    qubits = qubit_value(qubits)
    display_bits = set(probability_bits(request))
    return [
        bit
        for bit in range(qubits)
        if request.control_mask & (1 << bit) and bit not in display_bits
    ]


def probability_display_controls_match(request: ProbabilityOutputRequest, outcome: int) -> bool:
    for bit in probability_bits(request):
        mask = 1 << bit
        if request.control_mask & mask:
            actual = (outcome >> (bit - request.base_bit)) & 1
            expected = 1 if request.control_value & mask else 0
            if actual != expected:
                return False
    return True


def probability_control_index(
    request: ProbabilityOutputRequest, control_bits: Sequence[int]
) -> int:
    index = 0
    for offset, bit in enumerate(control_bits):
        if request.control_value & (1 << bit):
            index |= 1 << offset
    return index


def density_qargs(request: DensityOutputRequest) -> list[int]:
    # q0=LSB: web ビット位置 = Qiskit 量子ビット番号（恒等写像）。
    return list(density_bits(request))


def density_save_qargs(request: DensityOutputRequest, qubits: int | QubitCount) -> list[int]:
    qubits = qubit_value(qubits)
    return density_bits(request) + density_control_bits(request, qubits)


def density_bits(request: DensityOutputRequest) -> list[int]:
    return list(range(request.base_bit, request.base_bit + request.span))


def density_control_bits(request: DensityOutputRequest, qubits: int | QubitCount) -> list[int]:
    qubits = qubit_value(qubits)
    display_bits = set(density_bits(request))
    return [
        bit
        for bit in range(qubits)
        if request.control_mask & (1 << bit) and bit not in display_bits
    ]


def density_display_controls_match(request: DensityOutputRequest, outcome: int) -> bool:
    for bit in density_bits(request):
        mask = 1 << bit
        if request.control_mask & mask:
            actual = (outcome >> (bit - request.base_bit)) & 1
            expected = 1 if request.control_value & mask else 0
            if actual != expected:
                return False
    return True


def density_control_index(request: DensityOutputRequest, control_bits: Sequence[int]) -> int:
    index = 0
    for offset, bit in enumerate(control_bits):
        if request.control_value & (1 << bit):
            index |= 1 << offset
    return index


def saved_float(value: Any) -> float:
    return float(complex(value).real)


def qiskit_saved_amplitudes(saved: Any) -> list[complex]:
    return [complex(value) for value in list(saved)]


def qiskit_saved_probabilities(saved: Any) -> list[float]:
    return [float(value) for value in list(saved)]


def qiskit_saved_density_matrix(saved: Any) -> list[list[complex]]:
    raw = saved.data if hasattr(saved, "data") else saved
    rows = raw.tolist() if hasattr(raw, "tolist") else list(raw)
    return [[complex(value) for value in row] for row in rows]


def qiskit_basis_order(qubits: int | QubitCount) -> list[int]:
    # q0=LSB: web state index == Qiskit state index（恒等）。save_amplitudes には
    # 自然順の基底をそのまま渡せばよい。
    qubits = qubit_value(qubits)
    return list(range(1 << qubits))


def amplitude_display_response(
    request: AmplitudeOutputRequest, state: Sequence[complex], qubits: int | QubitCount
) -> dict[str, Any]:
    qubits = qubit_value(qubits)
    outcomes = 1 << request.span
    rest_count = 1 << (qubits - request.span)
    incoherent = [0.0] * outcomes
    best_rest = 0
    best_mag = -1.0
    incoherent_unity = 0.0

    for rest in range(rest_count):
        slice_mag = 0.0
        for outcome in range(outcomes):
            probability = abs(state_amp(state, request, rest, outcome)) ** 2
            slice_mag += probability
            incoherent[outcome] += probability
        incoherent_unity += slice_mag
        if slice_mag > best_mag:
            best_mag = slice_mag
            best_rest = rest

    raw_ket = [state_amp(state, request, best_rest, outcome) for outcome in range(outcomes)]
    unity = sum(abs(value) ** 2 for value in raw_ket)
    quality = amplitude_quality(state, request, raw_ket, unity, incoherent_unity, rest_count)
    phase_index, theta = amplitude_phase_lock(raw_ket, unity, request.phase_lock_enabled)
    normalized = normalize_amplitudes(raw_ket, unity, theta)
    incoherent_ket = normalize_incoherent(incoherent, incoherent_unity)
    return {
        "gate_id": request.gate_id,
        "span": request.span,
        "ket": [[value.real, value.imag] for value in normalized],
        "incoherent": incoherent_ket,
        "quality": quality,
        "phase_lock_index": phase_index,
    }


def state_amp(
    state: Sequence[complex], request: AmplitudeOutputRequest, rest: int, outcome: int
) -> complex:
    index = insert_outcome(rest, outcome, request.base_bit, request.span)
    if index >= len(state):
        return 0j
    if index & request.control_mask != request.control_value:
        return 0j
    return state[index]


def insert_outcome(rest: int, outcome: int, base_bit: int, span: int) -> int:
    span_mask = (1 << span) - 1
    low_mask = (1 << base_bit) - 1
    low = rest & low_mask
    high = rest & ~low_mask
    return (high << span) | ((outcome & span_mask) << base_bit) | low


def amplitude_quality(
    state: Sequence[complex],
    request: AmplitudeOutputRequest,
    raw_ket: Sequence[complex],
    unity: float,
    incoherent_unity: float,
    rest_count: int,
) -> float:
    if unity <= 1e-12 or incoherent_unity <= 1e-12:
        return 0.0
    denormalized = 0.0
    for rest in range(rest_count):
        dot_value = 0j
        for outcome, raw in enumerate(raw_ket):
            dot_value += raw.conjugate() * state_amp(state, request, rest, outcome)
        denormalized += abs(dot_value) ** 2
    return max(0.0, min(1.0, denormalized / (unity * incoherent_unity)))


def amplitude_phase_lock(
    raw_ket: Sequence[complex], unity: float, enabled: bool
) -> tuple[int, float]:
    if unity <= 1e-12 or not enabled:
        return -1, 0.0
    strongest = 0.0
    strongest_index = 0
    for outcome, raw in enumerate(raw_ket):
        probability = abs(raw) ** 2
        if probability > strongest * 10000.0:
            strongest = probability
            strongest_index = outcome
    if strongest <= 1e-8:
        return -1, 0.0
    return strongest_index, cmath.phase(raw_ket[strongest_index])


def normalize_amplitudes(raw_ket: Sequence[complex], unity: float, theta: float) -> list[complex]:
    if unity <= 1e-12:
        return [0j for _ in raw_ket]
    scale = 1 / math.sqrt(unity)
    rotation = cmath.exp(-1j * theta)
    return [value * scale * rotation for value in raw_ket]


def normalize_incoherent(probabilities: Sequence[float], unity: float) -> list[float]:
    scale = 1 / math.sqrt(max(unity, 1e-12))
    return [math.sqrt(max(value, 0.0)) * scale for value in probabilities]


def normalize_qiskit_counts(counts: dict[str, int]) -> dict[str, int]:
    # q0=LSB: Qiskit のビット列は qubit0(=wire0) を右端に置く little-endian で、
    # qni の ket |b_{n-1}..b_0⟩ とビット順が一致する。並べ替えは不要で、空白除去のみ。
    normalized: dict[str, int] = {}
    for key, value in counts.items():
        normalized[key.replace(" ", "")] = int(value)
    return dict(sorted(normalized.items()))


def histogram_response(
    *, runner: str, qubits: int, shots: int, histogram: dict[str, int]
) -> dict[str, Any]:
    return {
        "status": "completed",
        "runner": runner,
        "qubits": qubits,
        "shots": shots,
        "histogram": histogram,
        "truncated": False,
    }
