"""Held-out acceptance tests for the state-scoped data feature.

Derived only from the task specification (instruction.md). The suite covers the
basic tier of the specification; hierarchical scoping, parallel isolation,
history restoration, SCXML parsing and diagram annotation are tracked as a
follow-up tier and are not part of this baseline suite.

The candidate implementation lives in the workspace root (``statemachine/``);
these tests run after the runner restores the pristine ``tests/`` tree.
"""

import pickle

import pytest

from statemachine import State, StateChart
from statemachine.exceptions import InvalidDefinition


def _machine():
    class Machine(StateChart):
        idle = State(initial=True)
        a = State(data={"count": 0})
        b = State()
        enter_a = idle.to(a)
        leave_a = a.to(b)
        back = b.to(a)

    return Machine


def test_package_exports():
    from statemachine import DataChangeInfo, DataVar

    assert DataVar is not None
    assert DataChangeInfo is not None


def test_state_data_injected_into_enter_and_exit_callbacks():
    seen = {}

    class Machine(StateChart):
        idle = State(initial=True)
        a = State(data={"count": 0})
        b = State()
        enter_a = idle.to(a)
        leave_a = a.to(b)

        def on_enter_a(self, state_data=None):
            seen["enter"] = state_data

        def on_exit_a(self, state_data=None):
            seen["exit"] = state_data

    machine = Machine()
    machine.enter_a()
    assert isinstance(seen.get("enter"), dict), "state_data must be injected into on_enter callbacks"
    assert seen["enter"].get("count") == 0
    machine.leave_a()
    assert isinstance(seen.get("exit"), dict), "state_data must be injected into on_exit callbacks"


def test_get_state_data_active_and_inactive():
    machine = _machine()
    assert machine.get_state_data(machine.a) is None
    machine.enter_a()
    assert machine.get_state_data(machine.a) == {"count": 0}
    machine.leave_a()
    assert machine.get_state_data(machine.a) is None


def test_data_removed_on_exit_and_reset_on_reentry():
    machine = _machine()
    machine.enter_a()
    machine.set_state_data(machine.a, "count", 5)
    assert machine.get_state_data(machine.a)["count"] == 5
    machine.leave_a()
    assert machine.get_state_data(machine.a) is None
    machine.back()
    assert machine.get_state_data(machine.a) == {"count": 0}, "re-entry resets data to defaults"


def test_data_isolated_per_instance():
    first, second = _machine(), _machine()
    first.enter_a()
    second.enter_a()
    first.set_state_data(first.a, "count", 7)
    assert first.get_state_data(first.a)["count"] == 7
    assert second.get_state_data(second.a)["count"] == 0, "data must be per instance"


def test_plain_callable_is_treated_as_factory():
    calls = []

    def make_token():
        calls.append(len(calls))
        return len(calls)

    class Machine(StateChart):
        idle = State(initial=True)
        a = State(data={"token": make_token})
        b = State()
        enter_a = idle.to(a)
        leave_a = a.to(b)
        back = b.to(a)

    machine = Machine()
    machine.enter_a()
    first = machine.get_state_data(machine.a)["token"]
    machine.leave_a()
    machine.back()
    second = machine.get_state_data(machine.a)["token"]
    assert first != second, "plain callables in data must produce a fresh value per entry"
    assert len(calls) >= 2


def test_state_data_values_snapshot():
    machine = _machine()
    machine.enter_a()
    values = machine.state_data_values
    assert isinstance(values, dict)
    assert "a" in values, f"active data snapshot must be keyed by state identifier, got {values!r}"
    assert values["a"]["count"] == 0


def test_set_state_data_validates_active_state_and_declared_key():
    machine = _machine()
    machine.enter_a()
    with pytest.raises(InvalidDefinition):
        machine.set_state_data(machine.a, "missing", 1)
    with pytest.raises(InvalidDefinition):
        machine.set_state_data(machine.b, "count", 1)
    machine.set_state_data(machine.a, "count", 3)
    assert machine.get_state_data(machine.a)["count"] == 3


def test_invalid_data_declarations_raise_invalid_definition():
    with pytest.raises(InvalidDefinition):

        class NotAMapping(StateChart):
            a = State(initial=True, data=["count"])

    with pytest.raises(InvalidDefinition):

        class NotStringKeys(StateChart):
            a = State(initial=True, data={1: "value"})


def test_data_changes_are_recorded_and_cleared_per_macrostep():
    machine = _machine()
    machine.enter_a()
    changes = machine.get_data_changes()
    assert isinstance(changes, list) and changes, "entering a state with data must record changes"
    change = changes[-1]
    for attribute in ("state_id", "key", "old_value", "new_value"):
        assert hasattr(change, attribute), f"DataChangeInfo must expose {attribute}"
    assert change.state_id == "a"
    assert change.key == "count"
    machine.leave_a()
    later = machine.get_data_changes()
    initializations = [item for item in later if item.old_value is None and item.new_value == 0]
    assert not initializations, "changes must be cleared at the next macrostep boundary"


def test_data_survives_pickle():
    machine = _machine()
    machine.enter_a()
    machine.set_state_data(machine.a, "count", 4)
    restored = pickle.loads(pickle.dumps(machine))
    assert restored.get_state_data(restored.a)["count"] == 4

