#!/bin/bash

# Rebuild script for IC proposals (save and run this)
# Usage: ./rebuild.sh <proposal_type> <commit_hash>

TYPE=$1
COMMIT=$2

if [ -z "$TYPE" ] || [ -z "$COMMIT" ]; then
  echo "Usage: ./rebuild.sh <type> <commit>"
  exit 1
fi

case $TYPE in
  IcOsVersionDeployment)
    sudo apt-get update && sudo apt-get install -y curl git docker.io
    curl --proto '=https' --tlsv1.2 -sSLO https://raw.githubusercontent.com/dfinity/ic/$COMMIT/gitlab-ci/tools/repro-check.sh
    chmod +x repro-check.sh
    ./repro-check.sh -c $COMMIT
    sha256sum artifacts/canisters/*.wasm # Compare to expected hash
    ;;
  ProtocolCanisterManagement)
    git clone https://github.com/dfinity/ic
    cd ic
    git fetch --all
    git checkout $COMMIT
    ./ci/container/build-ic.sh -c
    sha256sum ./artifacts/canisters/*.wasm{,.gz}
    ;;
  Governance)
    echo 'Motion proposals do not require rebuild; verify summary manually.'
    ;;
  ParticipantManagement)
    echo 'NodeProvider: Download self-declaration PDFs from wiki, compute SHA-256, compare to proposal hashes.'
    echo 'Example: sha256sum yourfile.pdf'
    ;;
  *)
    echo 'Unknown type. Manual rebuild required.'
    ;;
esac