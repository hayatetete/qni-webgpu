import importlib.util
import json
import math
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
from contextlib import contextmanager
import urllib.error
import urllib.request

from qni_qiskit_backend.circuit import CircuitBuildError, apply_columns_to_qiskit, parse_angle
from qni_qiskit_backend.contract import (
    ContractError,
    QubitCapacity,
    QubitCount,
    QubitCountError,
    parse_run_request,
)
from qni_qiskit_backend.runners import (
    MockRunner,
    QiskitRunner,
    RunnerUnavailable,
    add_display_saves,
    add_qiskit_bloch,
    add_qiskit_density,
    add_qiskit_probability,
    amplitude_display_response,
    bloch_save_qargs,
    density_qargs,
    density_save_qargs,
    load_qiskit,
    normalize_qiskit_counts,
    probability_qargs,
    probability_save_qargs,
    select_runner,
)
from qni_qiskit_backend.server import make_server, parse_allowed_runners


@contextmanager
def running_test_server(default_runner, allowed_runners, proxy_token=""):
    server = make_server("127.0.0.1", 0, default_runner, allowed_runners, proxy_token)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@contextmanager
def server_subprocess(runner):
    # 読み込み状態はプロセス単位なので、別プロセスでサーバを立てる。
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    src_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
    env = {**os.environ, "PYTHONPATH": src_dir, "PYTHONUNBUFFERED": "1"}
    process = subprocess.Popen(
        [
            sys.executable, "-m", "qni_qiskit_backend",
            "--port", str(port),
            "--runner", runner,
            "--allowed-runners", runner,
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"{base_url}/health", timeout=2):
                    break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError(f"server exited early: {process.returncode}")
                time.sleep(0.25)
        else:
            raise RuntimeError("timed out waiting for the backend subprocess")
        yield base_url
    finally:
        process.terminate()
        process.wait(timeout=10)


class QubitCountTests(unittest.TestCase):
    def test_zero_qubit_count_is_rejected(self):
        with self.assertRaises(QubitCountError):
            QubitCount.create(0)

    def test_direct_zero_qubit_count_constructor_is_rejected(self):
        with self.assertRaises(QubitCountError):
            QubitCount(0)

    def test_one_qubit_count_is_accepted(self):
        self.assertEqual(QubitCount.create(1).value, 1)

    def test_local_capacity_rejects_seventeen_qubits(self):
        with self.assertRaises(QubitCountError):
            QubitCount.create_for_capacity(17, QubitCapacity.local())

    def test_external_gpu_capacity_accepts_thirty_two_qubits(self):
        self.assertEqual(
            QubitCount.create_for_capacity(32, QubitCapacity.external_gpu()).value, 32
        )

    def test_external_gpu_capacity_rejects_thirty_three_qubits(self):
        with self.assertRaises(QubitCountError):
            QubitCount.create_for_capacity(33, QubitCapacity.external_gpu())


class ContractTests(unittest.TestCase):
    def test_parse_angle_accepts_qni_implicit_multiplication(self):
        self.assertAlmostEqual(parse_angle("2π/3"), 2 * math.pi / 3)

    def test_parse_angle_accepts_qni_url_separator(self):
        self.assertAlmostEqual(parse_angle("π_2"), math.pi / 2)

    def test_qiskit_builder_applies_qni_implicit_phase(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def p(self, phase, wire):
                self.ops.append(("p", phase, wire))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["P(2π_3)"]], 1)
        self.assertAlmostEqual(fake.ops[0][1], 2 * math.pi / 3)

    def test_qiskit_builder_applies_qni_rx_url_angle(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def rx(self, phase, wire):
                self.ops.append(("rx", phase, wire))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["Rx(π_2)"]], 1)
        self.assertAlmostEqual(fake.ops[0][1], math.pi / 2)

    def test_parse_angle_rejects_empty_expression(self):
        with self.assertRaises(CircuitBuildError):
            parse_angle("")

    def test_parse_angle_rejects_zero_denominator(self):
        with self.assertRaises(CircuitBuildError):
            parse_angle("π_0")

    def test_rejects_full_statevector_output(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 2,
                    "columns": [],
                    "outputs": {"histogram": True, "statevector": True},
                }
            )

    def test_accepts_thirty_two_qubits(self):
        request = parse_run_request({"qubits": 32, "columns": [], "shots": 12})
        self.assertEqual(request.qubits.value, 32)

    def test_rejects_zero_qubits(self):
        with self.assertRaises(ContractError):
            parse_run_request({"qubits": 0, "columns": [], "shots": 12})

    def test_rejects_more_than_thirty_two_qubits(self):
        with self.assertRaises(ContractError):
            parse_run_request({"qubits": 33, "columns": [], "shots": 12})

    def test_mock_runner_returns_histogram_only_without_amplitude_requests(self):
        request = parse_run_request({"qubits": 3, "columns": [], "shots": 12})
        response = MockRunner().run(request)
        self.assertEqual(
            {
                "histogram": response["histogram"],
                "has_statevector": "statevector" in response,
                "has_probabilities": "probabilities" in response,
            },
            {"histogram": {"000": 12}, "has_statevector": False, "has_probabilities": False},
        )

    def test_qiskit_display_saves_do_not_allocate_amplitude_basis_without_amplitude_outputs(self):
        request = parse_run_request({"qubits": 32, "columns": [], "shots": 12})
        self.assertEqual(add_display_saves(object(), request, lambda axis: axis), ({}, {}, {}, {}))

    def test_contract_accepts_amplitude_output_requests(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["H"], ["Amps1"]],
                "outputs": {
                    "histogram": True,
                    "amplitudes": [
                        {
                            "gate_id": 2,
                            "column": 1,
                            "span": 1,
                            "base_bit": 0,
                            "control_mask": 0,
                            "control_value": 0,
                            "phase_lock_enabled": False,
                        }
                    ],
                },
            }
        )
        self.assertEqual(request.amplitude_outputs[0].gate_id, 2)

    def test_contract_rejects_large_exact_amplitude_outputs(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 17,
                    "columns": [["Amps1"]],
                    "outputs": {
                        "histogram": True,
                        "amplitudes": [
                            {
                                "gate_id": 1,
                                "column": 0,
                                "span": 1,
                                "base_bit": 0,
                                "control_mask": 0,
                                "control_value": 0,
                                "phase_lock_enabled": True,
                            }
                        ],
                    },
                }
            )

    def test_contract_rejects_too_many_amplitude_outputs(self):
        amplitudes = [
            {
                "gate_id": index,
                "column": 0,
                "span": 1,
                "base_bit": 0,
                "control_mask": 0,
                "control_value": 0,
                "phase_lock_enabled": False,
            }
            for index in range(33)
        ]
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 1,
                    "columns": [["Amps1"]],
                    "outputs": {"histogram": True, "amplitudes": amplitudes},
                }
            )

    def test_contract_accepts_bloch_output_requests(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["H"], ["Bloch"]],
                "outputs": {
                    "histogram": True,
                    "bloch": [{"gate_id": 2, "column": 1, "wire": 0}],
                },
            }
        )
        self.assertEqual(request.bloch_outputs[0].gate_id, 2)

    def test_contract_accepts_controlled_bloch_output_requests(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["•", "Bloch"]],
                "outputs": {
                    "histogram": True,
                    "bloch": [
                        {
                            "gate_id": 2,
                            "column": 0,
                            "wire": 1,
                            "control_mask": 1,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        self.assertEqual(request.bloch_outputs[0].control_mask, 1)

    def test_contract_rejects_bloch_control_value_outside_mask(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 2,
                    "columns": [["Bloch"]],
                    "outputs": {
                        "histogram": True,
                        "bloch": [
                            {
                                "gate_id": 2,
                                "column": 0,
                                "wire": 1,
                                "control_mask": 0,
                                "control_value": 2,
                            }
                        ],
                    },
                }
            )

    def test_contract_rejects_bloch_with_too_many_saved_control_bits(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 9,
                    "columns": [["•", "•", "•", "•", "•", "•", "•", "•", "Bloch"]],
                    "outputs": {
                        "histogram": True,
                        "bloch": [
                            {
                                "gate_id": 2,
                                "column": 0,
                                "wire": 8,
                                "control_mask": 255,
                                "control_value": 255,
                            }
                        ],
                    },
                }
            )

    def test_contract_rejects_too_many_bloch_outputs(self):
        bloch = [{"gate_id": index, "column": 0, "wire": 0} for index in range(65)]
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 1,
                    "columns": [["Bloch"]],
                    "outputs": {"histogram": True, "bloch": bloch},
                }
            )

    def test_contract_accepts_probability_output_requests(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["H"], ["Probability"]],
                "outputs": {
                    "histogram": True,
                    "probability": [{"gate_id": 2, "column": 1, "span": 1, "base_bit": 0}],
                },
            }
        )
        self.assertEqual(request.probability_outputs[0].gate_id, 2)

    def test_contract_accepts_controlled_probability_output_requests(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["•", "Probability"]],
                "outputs": {
                    "histogram": True,
                    "probability": [
                        {
                            "gate_id": 2,
                            "column": 0,
                            "span": 1,
                            "base_bit": 1,
                            "control_mask": 1,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        self.assertEqual(request.probability_outputs[0].control_mask, 1)

    def test_contract_rejects_probability_control_value_outside_mask(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 2,
                    "columns": [["Probability"]],
                    "outputs": {
                        "histogram": True,
                        "probability": [
                            {
                                "gate_id": 2,
                                "column": 0,
                                "span": 1,
                                "base_bit": 0,
                                "control_mask": 0,
                                "control_value": 2,
                            }
                        ],
                    },
                }
            )

    def test_contract_rejects_probability_with_too_many_saved_control_bits(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 17,
                    "columns": [["•"] + [1] * 15 + ["Probability16"]],
                    "outputs": {
                        "histogram": True,
                        "probability": [
                            {
                                "gate_id": 2,
                                "column": 0,
                                "span": 16,
                                "base_bit": 0,
                                "control_mask": 65536,
                                "control_value": 65536,
                            }
                        ],
                    },
                }
            )

    def test_contract_rejects_too_many_probability_outputs(self):
        probability = [
            {"gate_id": index, "column": 0, "span": 1, "base_bit": 0}
            for index in range(33)
        ]
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 1,
                    "columns": [["Probability"]],
                    "outputs": {"histogram": True, "probability": probability},
                }
            )

    def test_contract_accepts_density_output_requests(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["H", "H"], ["Density2"]],
                "outputs": {
                    "histogram": True,
                    "densities": [{"gate_id": 2, "column": 1, "span": 2, "base_bit": 0}],
                },
            }
        )
        self.assertEqual(request.density_outputs[0].gate_id, 2)

    def test_contract_accepts_controlled_density_output_requests(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["•", "Density"]],
                "outputs": {
                    "histogram": True,
                    "densities": [
                        {
                            "gate_id": 2,
                            "column": 0,
                            "span": 1,
                            "base_bit": 1,
                            "control_mask": 1,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        self.assertEqual(request.density_outputs[0].control_mask, 1)

    def test_contract_rejects_density_span_above_quirk_limit(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 9,
                    "columns": [["Density9"]],
                    "outputs": {
                        "histogram": True,
                        "densities": [{"gate_id": 1, "column": 0, "span": 9, "base_bit": 0}],
                    },
                }
            )

    def test_contract_rejects_density_with_too_many_saved_control_bits(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 9,
                    "columns": [["•", "Density8"]],
                    "outputs": {
                        "histogram": True,
                        "densities": [
                            {
                                "gate_id": 1,
                                "column": 0,
                                "span": 8,
                                "base_bit": 0,
                                "control_mask": 256,
                                "control_value": 256,
                            }
                        ],
                    },
                }
            )

    def test_contract_rejects_density_control_value_outside_mask(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 2,
                    "columns": [["Density"]],
                    "outputs": {
                        "histogram": True,
                        "densities": [
                            {
                                "gate_id": 1,
                                "column": 0,
                                "span": 1,
                                "base_bit": 0,
                                "control_mask": 0,
                                "control_value": 2,
                            }
                        ],
                    },
                }
            )

    def test_contract_rejects_density_control_mask_out_of_range(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {
                    "qubits": 2,
                    "columns": [["Density"]],
                    "outputs": {
                        "histogram": True,
                        "densities": [
                            {
                                "gate_id": 1,
                                "column": 0,
                                "span": 1,
                                "base_bit": 0,
                                "control_mask": 4,
                                "control_value": 0,
                            }
                        ],
                    },
                }
            )

    def test_qiskit_builder_ignores_amplitude_display_tokens(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["Amps1"]], 1)
        self.assertEqual(fake.ops, [])

    def test_qiskit_builder_ignores_bloch_display_tokens(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["Bloch"]], 1)
        self.assertEqual(fake.ops, [])

    def test_qiskit_builder_ignores_probability_display_tokens(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["Probability2"]], 2)
        self.assertEqual(fake.ops, [])

    def test_qiskit_builder_ignores_density_display_tokens(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["Density2"]], 2)
        self.assertEqual(fake.ops, [])

    def test_qiskit_builder_applies_write0_to_deterministic_one(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["X"], ["|0>"]], 1)
        self.assertEqual(fake.ops, [("x", 0), ("x", 0)])

    def test_qiskit_builder_rejects_write0_after_superposition(self):
        class FakeCircuit:
            def h(self, _wire):
                pass

        with self.assertRaises(CircuitBuildError):
            apply_columns_to_qiskit(FakeCircuit(), [["H"], ["|0>"]], 1)

    def test_qiskit_builder_applies_write1_to_deterministic_zero(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["|1>"]], 1)
        self.assertEqual(fake.ops, [("x", 0)])

    def test_qiskit_builder_rejects_write1_after_superposition(self):
        class FakeCircuit:
            def h(self, _wire):
                pass

        with self.assertRaises(CircuitBuildError):
            apply_columns_to_qiskit(FakeCircuit(), [["H"], ["|1>"]], 1)

    def test_qiskit_display_saves_tracks_write0_across_columns(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

        fake = FakeCircuit()
        request = parse_run_request({"qubits": 1, "columns": [["X"], ["|0>"]]})
        add_display_saves(fake, request, lambda axis: axis)
        self.assertEqual(fake.ops, [("x", 0), ("x", 0)])

    def test_qiskit_display_saves_rejects_write0_after_superposition(self):
        class FakeCircuit:
            def h(self, _wire):
                pass

        request = parse_run_request({"qubits": 1, "columns": [["H"], ["|0>"]]})
        with self.assertRaises(CircuitBuildError):
            add_display_saves(FakeCircuit(), request, lambda axis: axis)

    def test_qiskit_display_saves_tracks_write1_across_columns(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

        fake = FakeCircuit()
        request = parse_run_request({"qubits": 1, "columns": [["|1>"], ["|1>"]]})
        add_display_saves(fake, request, lambda axis: axis)
        self.assertEqual(fake.ops, [("x", 0)])

    def test_qiskit_display_saves_rejects_write1_after_superposition(self):
        class FakeCircuit:
            def h(self, _wire):
                pass

        request = parse_run_request({"qubits": 1, "columns": [["H"], ["|1>"]]})
        with self.assertRaises(CircuitBuildError):
            add_display_saves(FakeCircuit(), request, lambda axis: axis)

    def test_qiskit_builder_expands_qft2_token(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def h(self, wire):
                self.ops.append(("h", wire))

            def cp(self, phase, control, target):
                self.ops.append(("cp", phase, control, target))

            def swap(self, first, second):
                self.ops.append(("swap", first, second))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["QFT2", 1]], 2)
        self.assertEqual(
            fake.ops,
            [("swap", 0, 1), ("h", 0), ("cp", math.pi / 2, 1, 0), ("h", 1)],
        )

    def test_qiskit_builder_expands_qft_dagger2_token(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def h(self, wire):
                self.ops.append(("h", wire))

            def cp(self, phase, control, target):
                self.ops.append(("cp", phase, control, target))

            def swap(self, first, second):
                self.ops.append(("swap", first, second))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["QFT†2", 1]], 2)
        self.assertEqual(
            fake.ops,
            [("h", 1), ("cp", -math.pi / 2, 1, 0), ("h", 0), ("swap", 0, 1)],
        )

    def test_qiskit_builder_ignores_qft_span_overlapping_control_token(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def h(self, wire):
                self.ops.append(("h", wire))

            def cp(self, phase, control, target):
                self.ops.append(("cp", phase, control, target))

            def swap(self, first, second):
                self.ops.append(("swap", first, second))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["QFT2", "•"]], 2)
        self.assertEqual(
            fake.ops,
            [("swap", 0, 1), ("h", 0), ("cp", math.pi / 2, 1, 0), ("h", 1)],
        )

    def test_qiskit_display_saves_tracks_qft_as_unknown_basis(self):
        class FakeCircuit:
            def h(self, _wire):
                pass

            def cp(self, _phase, _control, _target):
                pass

            def swap(self, _first, _second):
                pass

        request = parse_run_request({"qubits": 2, "columns": [["QFT2", 1], ["|1>", 1]]})
        with self.assertRaises(CircuitBuildError):
            add_display_saves(FakeCircuit(), request, lambda axis: axis)

    def test_qiskit_builder_ignores_spacer_token(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["…"]], 1)
        self.assertEqual(fake.ops, [])

    def test_qiskit_builder_applies_measurement_after_column_unitaries(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def h(self, wire):
                self.ops.append(("h", wire))

            def measure(self, wire, bit):
                self.ops.append(("measure", wire, bit))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["Measure", "H"]], 2)
        self.assertEqual(fake.ops, [("h", 1), ("measure", 0, 0)])

    def test_qiskit_builder_ignores_controls_for_measurement(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def measure(self, wire, bit):
                self.ops.append(("measure", wire, bit))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•", "Measure"]], 2)
        self.assertEqual(fake.ops, [("measure", 1, 1)])

    def test_qiskit_builder_does_not_add_control_only_z_with_measurement(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def measure(self, wire, bit):
                self.ops.append(("measure", wire, bit))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•", "•", "Measure"]], 3)
        self.assertEqual(fake.ops, [("measure", 2, 2)])

    def test_qiskit_display_saves_measures_before_probability_save(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def measure(self, wire, bit):
                self.ops.append(("measure", wire, bit))

            def save_probabilities(self, qubits, label):
                self.ops.append(("save_probabilities", qubits, label))

        fake = FakeCircuit()
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["Measure"]],
                "outputs": {
                    "histogram": True,
                    "probability": [{"gate_id": 1, "column": 0, "span": 1, "base_bit": 0}],
                },
            }
        )
        add_display_saves(fake, request, lambda axis: axis)
        self.assertEqual(fake.ops, [("measure", 0, 0), ("save_probabilities", [0], "probability:1")])

    def test_qiskit_builder_applies_anti_controlled_x(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

            def mcx(self, controls, target):
                self.ops.append(("mcx", controls, target))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["◦", "X"]], 2)
        self.assertEqual(fake.ops, [("x", 0), ("mcx", [0], 1), ("x", 0)])

    def test_qiskit_builder_applies_anti_controlled_h(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

            def append(self, instruction):
                self.ops.append(instruction)

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["◦", "H"]], 2)
        self.assertEqual(
            fake.ops,
            [("x", 0), ("controlled", ("H", None), [0], [1]), ("x", 0)],
        )

    def test_qiskit_builder_applies_controlled_phase(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def append(self, instruction):
                self.ops.append(instruction)

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•", "P(π_4)"]], 2)
        self.assertEqual(fake.ops, [("controlled", ("P", "π/4"), [0], [1])])

    def test_qiskit_builder_applies_control_only_z(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def append(self, instruction):
                self.ops.append(instruction)

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•", "•"]], 2)
        self.assertEqual(fake.ops, [("controlled", ("Z", None), [1], [0])])

    def test_qiskit_builder_keeps_lone_control_as_no_op(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•"]], 1)
        self.assertEqual(fake.ops, [])

    def test_qiskit_builder_keeps_lone_anti_control_as_no_op(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["◦"]], 1)
        self.assertEqual(fake.ops, [])

    def test_qiskit_builder_does_not_add_control_only_z_with_target(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def mcx(self, controls, target):
                self.ops.append(("mcx", list(controls), target))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•", "•", "X"]], 3)
        self.assertEqual(fake.ops, [("mcx", [0, 1], 2)])

    def test_qiskit_builder_applies_controlled_sqrt_x_url_token(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def append(self, instruction):
                self.ops.append(instruction)

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•", "X^½"]], 2)
        self.assertEqual(fake.ops, [("controlled", ("SX", None), [0], [1])])

    def test_qiskit_builder_applies_controlled_qft(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def append(self, instruction):
                self.ops.append(instruction)

            def mcx(self, controls, target):
                self.ops.append(("mcx", list(controls), target))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•", "QFT2"]], 3)
        self.assertEqual(
            fake.ops,
            [
                # leading controlled bit-reversal swap (q1↔q2) gated by q0
                ("mcx", [0, 1], 2),
                ("mcx", [0, 2], 1),
                ("mcx", [0, 1], 2),
                ("controlled", ("H", None), [0], [1]),
                ("controlled", ("P", math.pi / 2), [0, 2], [1]),
                ("controlled", ("H", None), [0], [2]),
            ],
        )

    def test_qiskit_builder_applies_anti_controlled_qft_dagger(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

            def append(self, instruction):
                self.ops.append(instruction)

            def mcx(self, controls, target):
                self.ops.append(("mcx", list(controls), target))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["◦", "QFT†2"]], 3)
        self.assertEqual(
            fake.ops,
            [
                ("x", 0),
                ("controlled", ("H", None), [0], [2]),
                ("x", 0),
                ("x", 0),
                ("controlled", ("P", -math.pi / 2), [2, 0], [1]),
                ("x", 0),
                ("x", 0),
                ("controlled", ("H", None), [0], [1]),
                ("x", 0),
                # trailing bit-reversal swap (q1↔q2) gated by anti-control q0
                ("x", 0),
                ("mcx", [1, 0], 2),
                ("x", 0),
                ("x", 0),
                ("mcx", [2, 0], 1),
                ("x", 0),
                ("x", 0),
                ("mcx", [1, 0], 2),
                ("x", 0),
            ],
        )

    def test_qiskit_builder_keeps_diagonal_controlled_gate_basis(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def h(self, wire):
                self.ops.append(("h", wire))

            def append(self, instruction):
                self.ops.append(instruction)

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["H", 1], ["•", "Z"], [1, "|0>"]], 2)
        self.assertEqual(fake.ops, [("h", 0), ("controlled", ("Z", None), [0], [1])])

    def test_qiskit_builder_applies_active_controlled_write0(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

            def mcx(self, controls, target):
                self.ops.append(("mcx", list(controls), target))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["|1>", "|1>"], ["•", "|0>"]], 2)
        self.assertEqual(fake.ops, [("x", 0), ("x", 1), ("mcx", [0], 1)])

    def test_qiskit_builder_keeps_inactive_controlled_write0_as_no_op(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

            def mcx(self, controls, target):
                self.ops.append(("mcx", list(controls), target))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [[1, "|1>"], ["•", "|0>"], [1, "|1>"]], 2)
        self.assertEqual(fake.ops, [("x", 1)])

    def test_qiskit_builder_allows_inactive_controlled_write_with_unknown_target(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def h(self, wire):
                self.ops.append(("h", wire))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [[1, "H"], ["•", "|0>"]], 2)
        self.assertEqual(fake.ops, [("h", 1)])

    def test_qiskit_builder_applies_active_anti_controlled_write1(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

            def mcx(self, controls, target):
                self.ops.append(("mcx", list(controls), target))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["◦", "|1>"]], 2)
        self.assertEqual(fake.ops, [("x", 0), ("mcx", [0], 1), ("x", 0)])

    def test_qiskit_builder_allows_inactive_anti_controlled_write_with_unknown_target(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

            def h(self, wire):
                self.ops.append(("h", wire))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["|1>", "H"], ["◦", "|0>"]], 2)
        self.assertEqual(fake.ops, [("x", 0), ("h", 1)])

    def test_qiskit_display_saves_tracks_anti_control_across_columns(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

            def mcx(self, controls, target):
                self.ops.append(("mcx", controls, target))

        fake = FakeCircuit()
        request = parse_run_request({"qubits": 2, "columns": [["◦", "X"], [1, "|1>"]]})
        add_display_saves(fake, request, lambda axis: axis)
        self.assertEqual(fake.ops, [("x", 0), ("mcx", [0], 1), ("x", 0)])

    def test_qiskit_builder_applies_swap_pair(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def swap(self, first, second):
                self.ops.append(("swap", first, second))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["Swap", "Swap"]], 2)
        self.assertEqual(fake.ops, [("swap", 0, 1)])

    def test_qiskit_builder_ignores_stray_swap(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def swap(self, first, second):
                self.ops.append(("swap", first, second))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["Swap", 1]], 2)
        self.assertEqual(fake.ops, [])

    def test_qiskit_builder_ignores_controlled_stray_swap(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•", "Swap"]], 2)
        self.assertEqual(fake.ops, [])

    def test_qiskit_builder_applies_controlled_swap(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def mcx(self, controls, target):
                self.ops.append(("mcx", list(controls), target))

        fake = FakeCircuit()
        apply_columns_to_qiskit(fake, [["•", "Swap", "Swap"]], 3)
        self.assertEqual(
            fake.ops,
            [("mcx", [0, 1], 2), ("mcx", [0, 2], 1), ("mcx", [0, 1], 2)],
        )

    def test_qiskit_display_saves_tracks_swap_across_columns(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def x(self, wire):
                self.ops.append(("x", wire))

            def swap(self, first, second):
                self.ops.append(("swap", first, second))

        fake = FakeCircuit()
        request = parse_run_request(
            {"qubits": 2, "columns": [["|1>", 1], ["Swap", "Swap"], ["|1>", 1]]}
        )
        add_display_saves(fake, request, lambda axis: axis)
        self.assertEqual(fake.ops, [("x", 0), ("swap", 0, 1), ("x", 0)])

    def test_qiskit_display_saves_keeps_equal_basis_after_unknown_controlled_swap(self):
        class FakeCircuit:
            def __init__(self):
                self.ops = []

            def h(self, wire):
                self.ops.append(("h", wire))

            def mcx(self, controls, target):
                self.ops.append(("mcx", list(controls), target))

        fake = FakeCircuit()
        request = parse_run_request(
            {"qubits": 3, "columns": [["H", 1, 1], ["•", "Swap", "Swap"], [1, "|0>", "|0>"]]}
        )
        add_display_saves(fake, request, lambda axis: axis)
        self.assertEqual(
            fake.ops,
            [
                ("h", 0),
                ("mcx", [0, 1], 2),
                ("mcx", [0, 2], 1),
                ("mcx", [0, 1], 2),
            ],
        )

    def test_qiskit_display_saves_controlled_bloch_as_density_with_controls(self):
        class FakeCircuit:
            def __init__(self):
                self.saved = []

            def save_density_matrix(self, qubits, label):
                self.saved.append((qubits, label))

        fake = FakeCircuit()
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["•", "Bloch"]],
                "outputs": {
                    "histogram": True,
                    "bloch": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "wire": 1,
                            "control_mask": 1,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        labels = add_display_saves(fake, request, lambda axis: axis)
        self.assertEqual((fake.saved, labels[1]), ([([1, 0], "bloch:1:density")], {1: "bloch:1:density"}))

    def test_qiskit_display_saves_probability_with_web_order_qargs(self):
        class FakeCircuit:
            def __init__(self):
                self.saved = []

            def save_probabilities(self, qubits, label):
                self.saved.append((qubits, label))

        fake = FakeCircuit()
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["Probability2"]],
                "outputs": {
                    "histogram": True,
                    "probability": [{"gate_id": 1, "column": 0, "span": 2, "base_bit": 0}],
                },
            }
        )
        labels = add_display_saves(fake, request, lambda axis: axis)
        self.assertEqual((fake.saved, labels[2]), ([([0, 1], "probability:1")], {1: "probability:1"}))

    def test_qiskit_display_saves_density_with_web_order_qargs(self):
        class FakeCircuit:
            def __init__(self):
                self.saved = []

            def save_density_matrix(self, qubits, label):
                self.saved.append((qubits, label))

        fake = FakeCircuit()
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["Density2"]],
                "outputs": {
                    "histogram": True,
                    "densities": [{"gate_id": 1, "column": 0, "span": 2, "base_bit": 0}],
                },
            }
        )
        labels = add_display_saves(fake, request, lambda axis: axis)
        self.assertEqual((fake.saved, labels[3]), ([([0, 1], "density:1")], {1: "density:1"}))

    def test_qiskit_bloch_response_extracts_controlled_vector(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["•", "Bloch"]],
                "outputs": {
                    "histogram": True,
                    "bloch": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "wire": 1,
                            "control_mask": 1,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        response = {}
        add_qiskit_bloch(
            response,
            request,
            {
                "bloch:1:density": [
                    [0, 0, 0, 0],
                    [0, 0, 0, 0],
                    [0, 0, 0.25, -0.25j],
                    [0, 0, 0.25j, 0.25],
                ]
            },
            {1: "bloch:1:density"},
        )
        self.assertEqual(response["bloch"][0]["vector"], [0.0, 1.0, 0.0])

    def test_qiskit_probability_response_uses_saved_data(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["Probability"]],
                "outputs": {
                    "histogram": True,
                    "probability": [{"gate_id": 1, "column": 0, "span": 1, "base_bit": 0}],
                },
            }
        )
        response = {}
        add_qiskit_probability(response, request, {"probability:1": [0.25, 0.75]}, {1: "probability:1"})
        self.assertEqual(response["probability"][0]["probabilities"][1], 0.75)

    def test_qiskit_probability_response_extracts_controlled_slice(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["•", "Probability"]],
                "outputs": {
                    "histogram": True,
                    "probability": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "span": 1,
                            "base_bit": 1,
                            "control_mask": 1,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        response = {}
        add_qiskit_probability(response, request, {"probability:1": [0.4, 0.1, 0.0, 0.5]}, {1: "probability:1"})
        self.assertEqual(response["probability"][0]["probabilities"], [0.0, 1.0])

    def test_qiskit_density_response_uses_saved_data(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["Density"]],
                "outputs": {
                    "histogram": True,
                    "densities": [{"gate_id": 1, "column": 0, "span": 1, "base_bit": 0}],
                },
            }
        )
        response = {}
        add_qiskit_density(response, request, {"density:1": [[0.5, 0.25j], [-0.25j, 0.5]]}, {1: "density:1"})
        self.assertEqual(response["densities"][0]["cells"][1], [0.0, 0.25])

    def test_qiskit_density_response_extracts_controlled_block(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["•", "Density"]],
                "outputs": {
                    "histogram": True,
                    "densities": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "span": 1,
                            "base_bit": 1,
                            "control_mask": 1,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        response = {}
        add_qiskit_density(
            response,
            request,
            {"density:1": [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0.25, 0.1j], [0, 0, -0.1j, 0.75]]},
            {1: "density:1"},
        )
        self.assertEqual(
            response["densities"][0],
            {
                "gate_id": 1,
                "span": 1,
                "cells": [[0.25, 0.0], [0.0, 0.1], [0.0, -0.1], [0.75, 0.0]],
                "unity": 1.0,
            },
        )

    def test_qiskit_density_response_applies_display_bit_controls(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["Density2", "•"]],
                "outputs": {
                    "histogram": True,
                    "densities": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "span": 2,
                            "base_bit": 0,
                            "control_mask": 2,
                            "control_value": 2,
                        }
                    ],
                },
            }
        )
        response = {}
        add_qiskit_density(
            response,
            request,
            {"density:1": [[0.1, 0, 0, 0], [0, 0.2, 0, 0], [0, 0, 0.3, 0.4j], [0, 0, -0.4j, 0.4]]},
            {1: "density:1"},
        )
        self.assertEqual(
            response["densities"][0],
            {
                "gate_id": 1,
                "span": 2,
                "cells": [
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.3, 0.0],
                    [0.0, 0.4],
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.0, -0.4],
                    [0.4, 0.0],
                ],
                "unity": 0.7,
            },
        )

    def test_probability_qargs_match_web_outcome_order(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["Probability2"]],
                "outputs": {
                    "histogram": True,
                    "probability": [{"gate_id": 1, "column": 0, "span": 2, "base_bit": 0}],
                },
            }
        )
        self.assertEqual(probability_qargs(request.probability_outputs[0]), [0, 1])

    def test_bloch_save_qargs_include_controls_after_display_wire(self):
        request = parse_run_request(
            {
                "qubits": 3,
                "columns": [["•", "◦", "Bloch"]],
                "outputs": {
                    "histogram": True,
                    "bloch": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "wire": 2,
                            "control_mask": 3,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        self.assertEqual(bloch_save_qargs(request.bloch_outputs[0], 3), [2, 0, 1])

    def test_probability_save_qargs_include_controls_after_display_bits(self):
        request = parse_run_request(
            {
                "qubits": 3,
                "columns": [["•", "◦", "Probability"]],
                "outputs": {
                    "histogram": True,
                    "probability": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "span": 1,
                            "base_bit": 2,
                            "control_mask": 3,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        self.assertEqual(probability_save_qargs(request.probability_outputs[0], 3), [2, 0, 1])

    def test_density_qargs_match_web_outcome_order(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["Density2"]],
                "outputs": {
                    "histogram": True,
                    "densities": [{"gate_id": 1, "column": 0, "span": 2, "base_bit": 0}],
                },
            }
        )
        self.assertEqual(density_qargs(request.density_outputs[0]), [0, 1])

    def test_density_save_qargs_include_controls_after_display_bits(self):
        request = parse_run_request(
            {
                "qubits": 3,
                "columns": [["•", "◦", "Density"]],
                "outputs": {
                    "histogram": True,
                    "densities": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "span": 1,
                            "base_bit": 2,
                            "control_mask": 3,
                            "control_value": 1,
                        }
                    ],
                },
            }
        )
        self.assertEqual(density_save_qargs(request.density_outputs[0], 3), [2, 0, 1])

    def test_density_save_qargs_omits_display_control_bits(self):
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["Density2", "•"]],
                "outputs": {
                    "histogram": True,
                    "densities": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "span": 2,
                            "base_bit": 0,
                            "control_mask": 2,
                            "control_value": 2,
                        }
                    ],
                },
            }
        )
        self.assertEqual(density_save_qargs(request.density_outputs[0], 2), [0, 1])

    def test_mock_runner_returns_fixed_probability_outputs(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["Probability"]],
                "outputs": {
                    "histogram": True,
                    "probability": [{"gate_id": 1, "column": 0, "span": 1, "base_bit": 0}],
                },
            }
        )
        response = MockRunner().run(request)
        self.assertEqual(response["probability"][0]["probabilities"], [1.0, 0.0])

    def test_mock_runner_returns_fixed_bloch_outputs(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["Bloch"]],
                "outputs": {
                    "histogram": True,
                    "bloch": [{"gate_id": 1, "column": 0, "wire": 0}],
                },
            }
        )
        response = MockRunner().run(request)
        self.assertEqual(response["bloch"][0]["vector"], [0.0, 0.0, 1.0])

    def test_mock_runner_returns_fixed_density_outputs(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["Density"]],
                "outputs": {
                    "histogram": True,
                    "densities": [{"gate_id": 1, "column": 0, "span": 1, "base_bit": 0}],
                },
            }
        )
        response = MockRunner().run(request)
        self.assertEqual(response["densities"][0]["cells"][0], [1.0, 0.0])

    def test_mock_runner_returns_fixed_amplitude_outputs(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["Amps1"]],
                "outputs": {
                    "histogram": True,
                    "amplitudes": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "span": 1,
                            "base_bit": 0,
                            "control_mask": 0,
                            "control_value": 0,
                            "phase_lock_enabled": False,
                        }
                    ],
                },
            }
        )
        response = MockRunner().run(request)
        self.assertEqual(response["amplitudes"][0]["ket"], [[1.0, 0.0], [0.0, 0.0]])

    def test_amplitude_response_matches_h_state(self):
        request = parse_run_request(
            {
                "qubits": 1,
                "columns": [["Amps1"]],
                "outputs": {
                    "histogram": True,
                    "amplitudes": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "span": 1,
                            "base_bit": 0,
                            "control_mask": 0,
                            "control_value": 0,
                            "phase_lock_enabled": False,
                        }
                    ],
                },
            }
        )
        response = amplitude_display_response(request.amplitude_outputs[0], [2**-0.5, 2**-0.5], 1)
        self.assertEqual(round(response["ket"][1][0], 3), 0.707)

    def test_qiskit_runner_histogram_uses_q0_lsb_ket_order(self):
        # 実 Qiskit 実行で wire→qubit→state index→ket の規約全体を固定する。
        # X を wire0 だけに置くと wire0=1, wire1=0。q0=LSB では wire0(=q0) が
        # ket の右端なので "01"。reverseBits 時代の規約だと "10" になっていた。
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["X"]],
                "outputs": {"histogram": True},
            }
        )
        try:
            response = QiskitRunner(name="qiskit-cpu-dev", device="CPU").run(request)
        except RunnerUnavailable as exc:
            self.skipTest(str(exc))
        self.assertEqual(response["histogram"], {"01": request.shots})

    def test_qiskit_runner_amplitude_index_uses_q0_lsb(self):
        # X を wire0 だけに置くと状態は index 1 (= bit0/q0/wire0 が 1) に集中する。
        # qiskit_basis_order が恒等になったことを実 Qiskit 実行で固定する。
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [["X"]],
                "outputs": {
                    "histogram": True,
                    "amplitudes": [
                        {
                            "gate_id": 1,
                            "column": 0,
                            "span": 2,
                            "base_bit": 0,
                            "control_mask": 0,
                            "control_value": 0,
                            "phase_lock_enabled": False,
                        }
                    ],
                },
            }
        )
        try:
            response = QiskitRunner(name="qiskit-cpu-dev", device="CPU").run(request)
        except RunnerUnavailable as exc:
            self.skipTest(str(exc))
        ket = [[round(value, 6) for value in pair] for pair in response["amplitudes"][0]["ket"]]
        self.assertEqual(ket, [[0.0, 0.0], [1.0, 0.0], [0.0, 0.0], [0.0, 0.0]])

    def test_qiskit_runner_qft_is_symmetric_dft(self):
        # H on wire1 prepares (|0>+|2>)/√2; the symmetric DFT QFT2 maps it to
        # (|0>+|2>)/√2 in position space → probability 0.5 on outcomes 0 and 2.
        # A bit-reversed / wrong-side-swap QFT scrambles this, so the test pins
        # the QFT to Quirk's symmetric DFT through real Aer execution.
        request = parse_run_request(
            {
                "qubits": 2,
                "columns": [[1, "H"], ["QFT2"]],
                "outputs": {
                    "histogram": True,
                    "probability": [{"gate_id": 1, "column": 1, "span": 2, "base_bit": 0}],
                },
            }
        )
        try:
            response = QiskitRunner(name="qiskit-cpu-dev", device="CPU").run(request)
        except RunnerUnavailable as exc:
            self.skipTest(str(exc))
        probs = [round(p, 6) for p in response["probability"][0]["probabilities"]]
        self.assertEqual(probs, [0.5, 0.0, 0.5, 0.0])

    def test_cpu_dev_runner_is_explicit_not_fallback(self):
        runner = select_runner("qiskit-cpu-dev")
        self.assertEqual(
            (isinstance(runner, QiskitRunner), runner.device, runner.cu_state_vec),
            (True, "CPU", False),
        )

    def test_gpu_runner_requires_gpu_options(self):
        runner = select_runner("qiskit-gpu")
        self.assertEqual(
            (isinstance(runner, QiskitRunner), runner.device, runner.cu_state_vec),
            (True, "GPU", True),
        )

    def test_qiskit_counts_pass_through_in_qiskit_little_endian_order(self):
        # q0=LSB: Qiskit の little-endian ビット列 = qni の ket 順なので並べ替えなし。
        # 空白除去とキーのソートのみが起きる。
        self.assertEqual(normalize_qiskit_counts({"10": 5, "01": 7}), {"01": 7, "10": 5})

    def test_contract_defaults_to_allowed_gpu_runner(self):
        request = parse_run_request(
            {"qubits": 1, "columns": []},
            default_runner="qiskit-gpu",
            allowed_runners={"qiskit-gpu"},
        )
        self.assertEqual(request.runner, "qiskit-gpu")

    def test_contract_rejects_disallowed_runner(self):
        with self.assertRaises(ContractError):
            parse_run_request(
                {"qubits": 1, "columns": [], "runner": "mock"},
                default_runner="qiskit-gpu",
                allowed_runners={"qiskit-gpu"},
            )

    def test_allowed_runner_csv_parses_single_gpu_runner(self):
        self.assertEqual(parse_allowed_runners("qiskit-gpu"), {"qiskit-gpu"})

    def test_server_health_reports_only_allowed_gpu_runner(self):
        with running_test_server("qiskit-gpu", frozenset({"qiskit-gpu"})) as base_url:
            response = urllib.request.urlopen(f"{base_url}/health", timeout=2)
            body = json.loads(response.read().decode("utf-8"))
        self.assertEqual(body["runners"], ["qiskit-gpu"])

    def test_server_rejects_disallowed_runner_over_http(self):
        with running_test_server("qiskit-gpu", frozenset({"qiskit-gpu"})) as base_url:
            request = urllib.request.Request(
                f"{base_url}/run",
                data=json.dumps({"runner": "mock", "qubits": 1, "columns": []}).encode(
                    "utf-8"
                ),
                method="POST",
                headers={"content-type": "application/json"},
            )
            status = 0
            try:
                urllib.request.urlopen(request, timeout=2)
            except urllib.error.HTTPError as exc:
                status = exc.code
                exc.close()
        self.assertEqual(status, 400)

    def test_server_accepts_measurement_circuit_over_http(self):
        with running_test_server("mock", frozenset({"mock"})) as base_url:
            request = urllib.request.Request(
                f"{base_url}/run",
                data=json.dumps(
                    {"qubits": 1, "columns": [["Measure"]], "shots": 12}
                ).encode("utf-8"),
                method="POST",
                headers={"content-type": "application/json"},
            )
            response = urllib.request.urlopen(request, timeout=2)
            body = json.loads(response.read().decode("utf-8"))
        self.assertEqual(
            (body["status"], body["runner"], body["histogram"]),
            ("completed", "mock", {"0": 12}),
        )

    def test_server_rejects_run_without_required_proxy_token(self):
        with running_test_server(
            "qiskit-gpu",
            frozenset({"qiskit-gpu"}),
            proxy_token="secret-token",
        ) as base_url:
            request = urllib.request.Request(
                f"{base_url}/run",
                data=json.dumps({"qubits": 1, "columns": []}).encode("utf-8"),
                method="POST",
                headers={"content-type": "application/json"},
            )
            status = 0
            try:
                urllib.request.urlopen(request, timeout=2)
            except urllib.error.HTTPError as exc:
                status = exc.code
                exc.close()
        self.assertEqual(status, 400)

    def test_server_survives_repeated_qiskit_runs_in_worker_threads(self):
        # qiskit の初回読み込みをワーカースレッドで行うと、次のシミュレーションが
        # SIGSEGV でプロセスごと落ちる (qiskit 2.5.2 + qiskit-aer 0.17.2 +
        # numpy 2.4.6 で再現)。読み込み状態は プロセス単位なので、別プロセスの
        # サーバへ 2 回続けて実行を投げて確かめる。
        if importlib.util.find_spec("qiskit_aer") is None:
            self.skipTest("qiskit-aer is not installed")
        payload = json.dumps(
            {"qubits": 2, "columns": [["H", 1]], "shots": 64, "outputs": {"histogram": True}}
        ).encode("utf-8")
        with server_subprocess("qiskit-cpu-dev") as base_url:
            statuses = []
            for _ in range(2):
                request = urllib.request.Request(
                    f"{base_url}/run",
                    data=payload,
                    method="POST",
                    headers={"content-type": "application/json"},
                )
                try:
                    with urllib.request.urlopen(request, timeout=30) as response:
                        statuses.append(response.status)
                except OSError as exc:
                    statuses.append(f"failed: {exc}")

        self.assertEqual(statuses, [200, 200])


if __name__ == "__main__":
    unittest.main()
