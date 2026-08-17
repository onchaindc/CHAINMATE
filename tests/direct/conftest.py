"""Shared helpers for ChainMate direct-mode tests."""

import pytest


def to_hex(addr_bytes):
    """Convert an address fixture to the EIP-55 checksum hex the contract
    returns (str(gl.message.sender_address) == Address.as_hex)."""
    if hasattr(addr_bytes, "as_hex"):
        return addr_bytes.as_hex
    from genlayer.py.types import Address

    return Address(addr_bytes).as_hex


@pytest.fixture(autouse=True)
def _reset_contract_registry_after_each_test():
    """Each test redeploys the contract, which re-executes the module and
    redefines the ChainMate class. The GenVM std-lib tracks the single
    allowed Contract subclass in a module-global (`genvm_contracts.
    __known_contract__`) that gltest's direct-mode loader never clears, so
    every test after the first would raise "only one contract is allowed".
    Reset it after each test (the SDK is already importable by teardown
    because the loader put it on sys.path during the test)."""
    yield
    try:
        from genlayer.gl import genvm_contracts

        genvm_contracts.__known_contract__ = None
    except Exception:
        # SDK not importable in this environment — nothing to reset.
        pass
