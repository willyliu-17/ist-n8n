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
   Run `node --env-file=.env scripts/sync.js [workflow_name_or_path]` (for Production) or `node --env-file=.env.stag scripts/sync.js [workflow_name_or_path]` (for Staging) to download workflows into the `workflows/` directory. By default, it ignores archived workflows. To include them, append `--include-archived`.
   - **Selective Syncing**: You can sync a specific workflow by passing its name in quotes (e.g., `"My Workflow"`) or its local path (e.g., `workflows/my_workflow_123`). If omitted, it syncs all workflows.
   - **Conflict Resolution**: The script provides interactive CLI prompts for conflicts:
     - If multiple remote workflows share the exact same name, you will be prompted to select the correct target ID.
     - If a local directory exists with the same name but a different ID (e.g., pulling from Staging but the local folder has a Prod ID), you can choose to:
       - **[O] Overwrite**: Overwrites the local directory and forces the `workflow.json` ID back to the existing local ID. This is the standard path for cleanly pulling Staging changes back into the main Git repo.
       - **[N] New**: Creates a separate new directory with the new remote ID for isolated testing.
       - **[S] Skip**: Skips syncing the workflow.
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

## Remote Incident Investigation SOP

1. **Confirm the Target Environment**:
   - Explicitly confirm Production or Staging before making any direct remote REST API request. Do not infer the target from an environment file, workflow ID, or previous session.
   - Remote mutations, workflow activation, helper execution, and recovery side effects require explicit user approval.

2. **Use the n8n REST API First**:
   - Use the REST API rather than Playwright to inspect remote workflows and execution logs.
   - Query `/api/v1/executions?workflowId=<id>` to locate relevant executions and `/api/v1/executions/<id>?includeData=true` to inspect the actual executed nodes, inputs, outputs, errors, and sub-execution metadata.
   - Query `/api/v1/workflows/<id>` to verify the live workflow state and node configuration. Never assume the Git copy exactly matches the remote runtime.
   - Never print API keys, credentials, callback secrets, raw user data, or unrelated execution payloads. Output only the minimum redacted evidence needed for diagnosis.

3. **Trace the Exact Failure Boundary**:
   - Identify the last successful node and the first failing node, then inspect the data crossing that boundary.
   - Do not infer Slack, BigQuery, HTTP, or other node response shapes from documentation alone. Use the saved execution output from the affected n8n version as the authoritative runtime evidence.
   - Follow sub-execution metadata when an Execute Sub-workflow node is involved; a successful parent execution does not prove that an asynchronous child succeeded.

4. **Protect Data Table State**:
   - Invoke `n8n-node-configuration` before configuring or changing a Data Table node.
   - Treat `id`, `createdAt`, and `updatedAt` as auto-managed system columns. Never write them. Use primitive custom-column values only.
   - Before any recovery mutation, read all rows for the deterministic key and confirm exactly one canonical self-linked row.
   - Use an exact compare-and-swap update that includes the row identity, deterministic key, canonical linkage, status, lease snapshot, relevant checkpoint values, and an update snapshot such as `updatedAt`.
   - Immediately re-read and verify the persisted row. Treat a zero-row or partial update as a failed recovery.

5. **Avoid Duplicate Side Effects**:
   - If an external side effect succeeded but response parsing or checkpoint persistence failed, recover the actual result from saved execution data and persist that verified checkpoint with exact CAS.
   - Do not blindly rerun Slack posts, file uploads, AI calls, BigQuery jobs, webhooks, or other non-idempotent operations.
   - On replay, inspect the executed node list and prove that persisted checkpoints skipped already completed side effects.

6. **Clean Up Temporary Recovery Workflows**:
   - Temporary helpers must be minimal, inactive by default, validated before use, and restricted to the approved target and deterministic key.
   - Use a `finally` cleanup path to deactivate and delete every temporary helper after its single approved invocation, including when the invocation fails.
   - Do not save helper payloads, execution dumps, or diagnostic output in the repository.

7. **Verify Recovery End-to-End**:
   - Do not rely only on the overall execution status. Inspect the final execution path, terminal node output, persisted state, and absence of unintended side effects.
   - Run the lightest relevant local regression test and the repository verification gate when workflow files change.
   - Record execution IDs and bounded, redacted result fields as evidence; do not retain complete remote payloads.

8. **Use Playwright Only as a Fallback**:
   - Use Playwright only when the REST API cannot expose the required evidence and the user approves the fallback.
   - Never use browser automation to bypass API permissions, environment isolation, or approval requirements.

## Rules for AI Agents

- **Environment Confirmation**: You **MUST ALWAYS** ask the user to explicitly confirm the target environment (Production or Staging) before executing `sync.js` or `deploy.js`. Never assume the environment.
- **NEVER** commit any temporary files, log files, or debugging output (e.g., `*.txt`, `*.log`, `temp/`) to the repository.
- Always run `git status` before committing to verify the list of files being staged.
- **n8n Skill Requirement**: AI agents MUST utilize relevant n8n skills (e.g., `n8n-node-configuration`, `n8n-expression-syntax`, `n8n-workflow-patterns`, `n8n-mcp-tools-expert`, `n8n-code-javascript`, `n8n-validation-expert`) for all development, configuration, and debugging of n8n workflows.
- **Workflow Directory Structure**: Be aware that workflows are stored as unpacked directories. When reading or modifying workflow code manually, interact with the extracted files under `workflows/<workflow_name>/nodes/`.
