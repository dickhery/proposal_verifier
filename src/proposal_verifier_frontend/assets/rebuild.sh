#!/bin/bash

# Rebuild script for IC proposals (save and run this)
sudo apt-get update && sudo apt-get install -y curl git docker.io
curl --proto '=https' --tlsv1.2 -sSLO https://raw.githubusercontent.com/dfinity/ic/$1/gitlab-ci/tools/repro-check.sh
chmod +x repro-check.sh
./repro-check.sh -c $1
sha256sum artifacts/canisters/*.wasm # Compare to expected hash