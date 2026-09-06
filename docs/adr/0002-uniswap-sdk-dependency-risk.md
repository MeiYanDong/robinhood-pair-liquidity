# ADR 0002: Isolate the official Uniswap SDK dependency risk

- Status: accepted temporarily
- Date: 2026-09-06

## Context

The latest official `@uniswap/v4-sdk` (`2.3.3`) requires `@uniswap/v3-sdk` and ethers v5. The resulting
dependency tree reports high-severity npm advisories, including legacy Hardhat/build-tool packages pulled
through `@uniswap/swap-router-contracts`. `npm audit fix` has no non-breaking remediation; its proposed
forced changes downgrade or replace core Uniswap SDK versions and could alter position math or calldata.

The executor uses the V4 SDK to construct concentrated-liquidity positions and PositionManager calldata.
It uses viem, not ethers, for RPC, account derivation, signing, and transaction broadcast. The public
dashboard does not import or deploy any Uniswap SDK package.

## Decision

Pin the official SDK versions used by the already verified execution path. Do not force an unaudited
breaking dependency change during an unrelated position consolidation. Keep the production dashboard in
its own dependency manifest and block CI when that runtime has a high-severity advisory. Monitor upstream
updates weekly with Dependabot.

Operator inputs remain trusted local configuration; executor processes are short lived and do not expose a
network service. This reduces exposure but does not erase the dependency findings.

## Exit criteria

Replace or upgrade the SDK dependency when one of these can pass calldata-equivalence fixtures for collect,
remove, add, and mint plus the full preflight test suite:

1. an upstream release removes the vulnerable dependency chain;
2. a minimal viem-native calldata builder is independently reviewed; or
3. patched transitive versions are proven API-compatible and remove the advisories.

Until then, root `npm audit --omit=dev` is expected to report the acknowledged findings. The dashboard's
clean runtime audit must never be presented as proof that the operator dependency tree is clean.
