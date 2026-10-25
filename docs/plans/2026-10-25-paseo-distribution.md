# Paseo distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Package verified Paseo 0.1.7 and Omnigent 0.3.12 for future PaaS and Home Assistant deployments and verify Store/local-build synchronization.

**Architecture:** Build pinned plugin artifacts and Paseo runtime into architecture-specific images. The k3s base uses the combined native Pi Web 0.10 adapter; HA keeps its existing Pi Web 0.12 ingress bridge. Credentials, pairing, and onboarding remain per-installation persistent state.

**Tech Stack:** Node 22, Docker Buildx, GitHub Actions, Gitea Actions, Helm, HA Supervisor distribution tooling.

## Task 1: k3s base package
- Modify Dockerfile plugin pins, combined adapter hash, runtime build and ownership.
- Add rootfs/usr/local/bin/pi-paseo-seed.mjs; invoke before server startup while respecting removals and overrides.
- Extend startup and offline runtime regression coverage; build a new immutable 0.3.3 image and release chart.

## Task 2: Home Assistant
- Modify HA Dockerfile, config.yaml, CHANGELOG.md, ingress bridge lifecycle and frontend for Paseo.
- Package runtime during build, retain Pi Web 0.12 and existing add-on options.
- Run unit, ingress and image-smoke checks; publish 0.16.0 only through passing PR checks.

## Task 3: PaaS consumption
- Pin pi-agent/Dockerfile to verified base image digest; preserve required overlay patches and non-root ownership.
- Build and inspect the PaaS candidate, then use the repository promotion workflow.
- Update the Pi chart and future platform defaults to the verified version through the existing release process; retain current services.

## Task 4: Distribution synchronization
- Follow Gitea to GitHub mirror, HA Release to notification to Store to local download/source build.
- Compare version, source SHA, artifact hashes, architecture manifests and generated build contexts.
- Inspect actual Supervisor Store cache/local copies when accessible; distinguish unavailable live targets from source verification.

## Completion evidence
Record exact commits, releases, image digests and synchronization receipts. Do not claim a deployment channel ready until its artifact is published and validated. Never publish credentials, tenant routes, pairing URLs or private infrastructure inventory.
