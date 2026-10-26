# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Tests: `node --test tests/` (one file: `node --test tests/parser.test.js`). No dependencies.
- Package: `./build.sh` runs the tests, bumps `version` in `plugin/komari-plugin.json` (YY.MMDD.N), and writes `dist/ip-quality.zip`.

## Architecture

A Komari plugin (CommonJS, runs in Komari's Goja runtime: no optional chaining or `??`, `server` comes from `require("server")`).

- `plugin/script.js`: registers `GET /snapshot` (public) and `POST /probe` (admin) and starts the manager.
- `plugin/lib/probe.js`: `buildRemoteCommand` makes the shell command sent through `admin:exec`; `createProbeManager` dispatches it, polls `admin:getTaskById`, and keeps `snapshot.json` in `__storageDir__`. Read path never touches a node.
- `plugin/lib/parser.js`: turns the IPQuality JSON (one `===IPQ4===` / `===IPQ6===` section per stack in the task output) into the stored record. Media results are dropped; IPs are masked.
- Consumer: the Omarchy theme (`../komari-theme-omarchy`) reads the snapshot, like it does for unlock-test.

## Constraints

- IPQuality is AGPL-3.0: never copy its code here, only run it on the node and read its output.
- The node command must keep `-p` (no upload to check.place) and must not pass `-f` (full IP). Tests cover both.
- Hidden nodes and error text must not reach the public snapshot (`view(false)`).
