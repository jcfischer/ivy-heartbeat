#!/bin/bash
set -euo pipefail

BINARY_NAME="ivy-heartbeat"
DIST_DIR="dist"
INSTALL_DIR="${HOME}/bin"

echo "Building ${BINARY_NAME}..."
mkdir -p "${DIST_DIR}"
bun build src/cli.ts --compile --outfile "${DIST_DIR}/${BINARY_NAME}"

echo "Signing binary (ad-hoc)..."
xattr -cr "${DIST_DIR}/${BINARY_NAME}" 2>/dev/null || true
codesign -f -s - "${DIST_DIR}/${BINARY_NAME}"

echo "Installing to ${INSTALL_DIR}/${BINARY_NAME}..."
mkdir -p "${INSTALL_DIR}"
cp "${DIST_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}"
xattr -cr "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null || true
codesign -f -s - "${INSTALL_DIR}/${BINARY_NAME}"

echo "Done. $(${INSTALL_DIR}/${BINARY_NAME} --version)"
