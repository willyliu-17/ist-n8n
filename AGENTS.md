# n8n Git-Centric Workspace

This repository manages n8n workflows using a Git-centric, local-sandboxed architecture.

## Architecture

1. **Git as Source of Truth**: The `workflows/` directory reflects the desired state of the target environments.
2. **Staging Environment**: A local Docker-based n8n instance acting as the staging environment.
3. **Local Sandboxed AI**: Opencode (`opencode.json`) is strictly bound to the **Local n8n** (`http://localhost:5678`). AI agents **do not** have access to the Remote or Staging environments via MCP.
4. **Automated Scripts**: `scripts/sync.js` and `scripts/deploy.js` bridge the gap between Git and the target n8n environments.
5. **Workflow Structure**: To facilitate clean version control and code reviews, workflows are stored as directories under `workflows/` rather than flat JSON files.
   - `sync.js` unpacks exported JSONs, extracting code nodes (like JavaScript) into separate files (e.g., `nodes/<node-name>/jsCode.js`) and replacing them with `__EXTERNAL_FILE__://` references in a central `workflow.json`.
   - `deploy.js` and local tooling use `scripts/utils.js` to reassemble these references back into a native n8n JSON payload before deployment.

## Secrets Management

- **DO NOT** commit `.env`, `.env.stag`, or `opencode.json`. They are explicitly listed in `.gitignore`.
- `.env` contains the Production (Remote) API credentials.
- `.env.stag` contains the Staging (Local Docker) API credentials.
- `opencode.json` contains the Local API credentials for MCP. **Important**: The file must be named exactly `opencode.json` (not `opencode.remote.json` or similar) to ensure AI agents correctly connect to the Local sandbox.
- Use `.env.example` and `opencode.example.json` as templates if cloning this repository.

## Developer SOP

1. **Sync (Remote to Git)**:
   Run `node --env-file=.env scripts/sync.js` (for Production) or `node --env-file=.env.stag scripts/sync.js` (for Staging) to download the latest workflows into the `workflows/` directory. By default, it ignores archived workflows. To include them, append `--include-archived`.
   **Important**: Always explicitly confirm the target environment before running this command.

2. **Import (Git to Local)**:
   To populate your Local n8n with the synced workflows, override the environment variables and use the deploy script:
   ```bash
   REMOTE_N8N_API_URL="http://localhost:5678" REMOTE_N8N_API_KEY="<your_local_key>" node scripts/deploy.js workflows/*
   ```

3. **Develop & Test (Local-First)**:
   - Develop and modify your workflows locally.
   - Test your logic thoroughly in the local sandbox before proceeding.

4. **Deploy Audit**:
   - Once local testing is verified, the AI ensures the `workflows/` directory structure (code files and `workflow.json`) is correct. If editing manually, ensure code is properly externalized or re-run `sync.js` to unpack.
   - The AI must present a summary and run a `git diff` for human review.
   - *(Optional)* If the `human-agent-interface` skill is available, the AI is encouraged to use its HTML mechanism for a better review experience.
   - The AI must ask for explicit approval before proceeding to deployment.

5. **Deploy (Git to Remote)**:
   - Run `node --env-file=.env scripts/deploy.js workflows/<folder>` (for Production) or `node --env-file=.env.stag scripts/deploy.js workflows/<folder>` (for Staging) to push the changes.
   - Commit the changes to Git.
   **Important**: Always explicitly confirm the target environment before running this command.

## Rules for AI Agents

- **Environment Confirmation**: You **MUST ALWAYS** ask the user to explicitly confirm the target environment (Production or Staging) before executing `sync.js` or `deploy.js`. Never assume the environment.
- **NEVER** commit any temporary files, log files, or debugging output (e.g., `*.txt`, `*.log`, `temp/`) to the repository.
- Always run `git status` before committing to verify the list of files being staged.
- **n8n Skill Requirement**: AI agents MUST utilize relevant n8n skills (e.g., `n8n-node-configuration`, `n8n-expression-syntax`, `n8n-workflow-patterns`, `n8n-mcp-tools-expert`, `n8n-code-javascript`, `n8n-validation-expert`) for all development, configuration, and debugging of n8n workflows.
- **Workflow Directory Structure**: Be aware that workflows are stored as unpacked directories. When reading or modifying workflow code manually, interact with the extracted files under `workflows/<workflow_name>/nodes/`.
