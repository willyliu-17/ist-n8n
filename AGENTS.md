# n8n Git-Centric Workspace

This repository manages n8n workflows using a Git-centric, local-sandboxed architecture.

## Architecture

1. **Git as Source of Truth**: The `workflows/` directory reflects the desired state of the Production (Remote) environment.
2. **Local Sandboxed AI**: Opencode (`opencode.json`) is strictly bound to the **Local n8n** (`http://localhost:5678`). AI agents **do not** have access to the Remote environment via MCP.
3. **Automated Scripts**: `scripts/sync.js` and `scripts/deploy.js` bridge the gap between Git and the Remote n8n.

## Secrets Management

- **DO NOT** commit `.env` or `opencode.json`. They are explicitly listed in `.gitignore`.
- `.env` contains the Remote API credentials.
- `opencode.json` contains the Local API credentials for MCP.
- Use `.env.example` and `opencode.example.json` as templates if cloning this repository.

## Developer SOP

1. **Sync**:
   Run `node --env-file=.env scripts/sync.js` to download the latest Remote workflows into the `workflows/` directory. By default, it ignores archived workflows. To include them, append `--include-archived`.

2. **Develop & Test (Local-First)**:
   - Ask the AI to build or modify workflows via MCP. The AI operates safely on your **Local n8n** sandbox.
   - Test your logic locally.

3. **Deploy Audit (HAI)**:
   - Once local testing is verified, the AI saves the final workflow JSON to the `workflows/` directory.
   - The AI must present a summary and run a `git diff` for human review using the Human Agent Interface (HAI) HTML mechanism.
   - The AI must ask for explicit approval before proceeding to deployment.

4. **Deploy**:
   - Run `node --env-file=.env scripts/deploy.js workflows/<file>.json` (you can specify multiple files) to push the changes to Production.
   - Commit the changes to Git.