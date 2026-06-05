# n8n Git-Centric Workspace

This repository manages n8n workflows using a Git-centric, local-sandboxed architecture.

## Architecture

1. **Git as Source of Truth**: The `workflows/` directory reflects the desired state of the Production (Remote) environment.
2. **Local Sandboxed AI**: Opencode (`opencode.json`) is strictly bound to the **Local n8n** (`http://localhost:5678`). AI agents **do not** have access to the Remote environment via MCP.
3. **Automated Scripts**: `scripts/sync.js` and `scripts/deploy.js` bridge the gap between Git and the Remote n8n.

## Secrets Management

- **DO NOT** commit `.env` or `opencode.json`. They are explicitly listed in `.gitignore`.
- `.env` contains the Remote API credentials.
- `opencode.json` contains the Local API credentials for MCP. **Important**: The file must be named exactly `opencode.json` (not `opencode.remote.json` or similar) to ensure AI agents correctly connect to the Local sandbox.
- Use `.env.example` and `opencode.example.json` as templates if cloning this repository.

## Developer SOP

1. **Sync (Remote to Git)**:
   Run `node --env-file=.env scripts/sync.js` to download the latest Remote workflows into the `workflows/` directory. By default, it ignores archived workflows. To include them, append `--include-archived`.

2. **Import (Git to Local)**:
   To populate your Local n8n with the synced workflows, override the environment variables and use the deploy script:
   ```bash
   REMOTE_N8N_API_URL="http://localhost:5678" REMOTE_N8N_API_KEY="<your_local_key>" node scripts/deploy.js workflows/*.json
   ```

3. **Develop & Test (Local-First)**:
   - Ask the AI to build or modify workflows via MCP. The AI operates safely on your **Local n8n** sandbox.
   - Test your logic locally.

4. **Deploy Audit**:
   - Once local testing is verified, the AI saves the final workflow JSON to the `workflows/` directory.
   - The AI must present a summary and run a `git diff` for human review.
   - *(Optional)* If the `human-agent-interface` skill is available, the AI is encouraged to use its HTML mechanism for a better review experience.
   - The AI must ask for explicit approval before proceeding to deployment.

5. **Deploy (Git to Remote)**:
   - Run `node --env-file=.env scripts/deploy.js workflows/<file>.json` (you can specify multiple files) to push the changes to Production.
   - Commit the changes to Git.

## Rules for AI Agents

- **NEVER** commit any temporary files, log files, or debugging output (e.g., `*.txt`, `*.log`, `temp/`) to the repository.
- Always run `git status` before committing to verify the list of files being staged.
