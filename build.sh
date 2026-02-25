#!/bin/bash
set -euo pipefail

# ivy-heartbeat runs directly via Bun (no compiled binary).
# This script installs a shell wrapper to ~/bin/ivy-heartbeat.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/bin"

mkdir -p "${INSTALL_DIR}"

cat > "${INSTALL_DIR}/ivy-heartbeat" << WRAPPER
#!/bin/bash
exec bun ${SCRIPT_DIR}/src/cli.ts "\$@"
WRAPPER

chmod +x "${INSTALL_DIR}/ivy-heartbeat"

echo "Installed ivy-heartbeat wrapper → ${INSTALL_DIR}/ivy-heartbeat"
echo "Version: $(${INSTALL_DIR}/ivy-heartbeat --version)"
