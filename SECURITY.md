# Security

This repository must not contain private keys, seed phrases, wallet-export files, RPC credentials, server credentials, `.env` files, or private runtime ledgers under `runs/`.

Executors read the signing key from the local macOS Keychain. Public reports contain only addresses and canonical chain evidence. Before publication, run the repository secret scan documented in the README and inspect the exact Git index.

Report a suspected exposure privately to the repository owner; do not open a public issue containing secret material.

The production dashboard installs only `dashboard/package-lock.json`; its runtime audit is a CI gate. The
operator package also pins the latest official Uniswap V4 SDK, whose dependency tree currently includes
known high-severity findings in legacy/build tooling and ethers v5. This risk is documented in ADR 0002
and is not silently waived or auto-fixed across a breaking SDK version.
