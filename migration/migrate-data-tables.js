const fs = require('node:fs');
const path = require('node:path');
const { createApi } = require('../scripts/n8n-api');

const SYSTEM_COLUMNS = new Set(['id', 'createdAt', 'updatedAt']);

function sanitizeRowForInsert(row) {
    const clean = {};
    for (const [key, value] of Object.entries(row)) {
        if (!SYSTEM_COLUMNS.has(key)) {
            clean[key] = value;
        }
    }
    return clean;
}

async function exportTables({ sourceApi, outputDir, tableNames = [] }) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const sourceTables = await sourceApi.list('data-tables');
    const filtered = tableNames.length > 0
        ? sourceTables.filter(t => tableNames.includes(t.name))
        : sourceTables;

    console.log(`Found ${filtered.length} table(s) to export from source.`);
    const manifest = [];

    for (const table of filtered) {
        console.log(`Exporting table: "${table.name}" (ID: ${table.id})...`);
        const detail = await sourceApi.request(`data-tables/${table.id}`);
        const customColumns = (detail.columns || []).filter(c => !SYSTEM_COLUMNS.has(c.name));

        const rows = [];
        let cursor;
        do {
            const query = new URLSearchParams({ limit: '100' });
            if (cursor) query.set('cursor', cursor);
            const page = await sourceApi.request(`data-tables/${table.id}/rows?${query}`);
            const batch = page.data || [];
            rows.push(...batch);
            cursor = page.nextCursor;
        } while (cursor);

        const tablePayload = {
            id: table.id,
            name: table.name,
            columns: customColumns.map(c => ({ name: c.name, type: c.type })),
            rowCount: rows.length,
            rows: rows.map(sanitizeRowForInsert)
        };

        const filePath = path.join(outputDir, `${table.name}.json`);
        fs.writeFileSync(filePath, JSON.stringify(tablePayload, null, 2), 'utf8');
        console.log(`  Saved ${rows.length} row(s) to ${filePath}`);

        manifest.push({
            id: table.id,
            name: table.name,
            columnsCount: customColumns.length,
            rowCount: rows.length,
            file: `${table.name}.json`
        });
    }

    const manifestPath = path.join(outputDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ exportedAt: new Date().toISOString(), tables: manifest }, null, 2), 'utf8');
    console.log(`Export complete! Manifest written to ${manifestPath}`);
    return manifest;
}

async function importTables({ targetApi, inputDir, dryRun = false, batchSize = 250 }) {
    const manifestPath = path.join(inputDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Manifest not found at: ${manifestPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const targetTables = await targetApi.list('data-tables');
    const targetTableByName = new Map(targetTables.map(t => [t.name, t]));

    console.log(`=== Importing ${manifest.tables.length} table(s) from ${inputDir} ===`);

    for (const entry of manifest.tables) {
        const filePath = path.join(inputDir, entry.file);
        if (!fs.existsSync(filePath)) {
            console.error(`Missing data file: ${filePath}`);
            continue;
        }

        const tableData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let targetTable = targetTableByName.get(tableData.name);

        if (!targetTable) {
            console.log(`Table "${tableData.name}" does not exist on target.`);
            if (dryRun) {
                console.log(`  [Dry-Run] Would create table "${tableData.name}" with ${tableData.columns.length} columns.`);
            } else {
                console.log(`  Creating table "${tableData.name}" on target...`);
                targetTable = await targetApi.request('data-tables', {
                    method: 'POST',
                    body: {
                        name: tableData.name,
                        columns: tableData.columns
                    }
                });
                console.log(`  Created table with ID: ${targetTable.id}`);
                targetTableByName.set(targetTable.name, targetTable);
            }
        } else {
            console.log(`Table "${tableData.name}" already exists on target (ID: ${targetTable.id}).`);
        }

        let targetId = targetTable?.id;
        const rows = tableData.rows || [];

        if (dryRun) {
            console.log(`  [Dry-Run] Would insert ${rows.length} row(s) into table "${tableData.name}".`);
            continue;
        }

        if (!targetId) {
            console.error(`Cannot insert rows: table ID unavailable for "${tableData.name}"`);
            continue;
        }

        // Check if rows already exist on target
        let existingRowCount = 0;
        let checkCursor;
        do {
            const query = new URLSearchParams({ limit: '250' });
            if (checkCursor) query.set('cursor', checkCursor);
            const page = await targetApi.request(`data-tables/${targetId}/rows?${query}`);
            existingRowCount += (page.data || []).length;
            checkCursor = page.nextCursor;
        } while (checkCursor);

        if (existingRowCount === rows.length) {
            console.log(`  Table "${tableData.name}" already has ${existingRowCount} row(s) (matches backup). Skipping.`);
            continue;
        }

        if (existingRowCount > 0) {
            console.log(`  Table "${tableData.name}" has partial rows (${existingRowCount}/${rows.length}). Recreating table...`);
            await targetApi.request(`data-tables/${targetId}`, { method: 'DELETE' });
            targetTable = await targetApi.request('data-tables', {
                method: 'POST',
                body: {
                    name: tableData.name,
                    columns: tableData.columns
                }
            });
            targetId = targetTable.id;
            targetTableByName.set(tableData.name, targetTable);
            console.log(`  Recreated table with ID: ${targetId}`);
        }

        console.log(`  Inserting ${rows.length} row(s) into table "${tableData.name}" (ID: ${targetId})...`);
        let inserted = 0;

        for (let i = 0; i < rows.length; i += batchSize) {
            const chunk = rows.slice(i, i + batchSize);
            const res = await targetApi.request(`data-tables/${targetId}/rows`, {
                method: 'POST',
                body: { data: chunk }
            });
            inserted += (res.insertedRows || chunk.length);
            if ((i + batchSize) % 1000 === 0 || i + batchSize >= rows.length) {
                console.log(`    Progress: ${inserted}/${rows.length} rows inserted...`);
            }
        }

        console.log(`  Finished inserting ${inserted} row(s) into "${tableData.name}".`);
    }

    console.log('Import completed.');
}

async function verifyTables({ sourceApi, targetApi }) {
    const [sourceTables, targetTables] = await Promise.all([
        sourceApi.list('data-tables'),
        targetApi.list('data-tables')
    ]);

    console.log('=== DATA TABLE VERIFICATION SUMMARY ===');
    console.log(`Source tables: ${sourceTables.length}, Target tables: ${targetTables.length}\n`);

    const targetMap = new Map(targetTables.map(t => [t.name, t]));

    for (const sTable of sourceTables) {
        const tTable = targetMap.get(sTable.name);
        if (!tTable) {
            console.log(`[MISSING] Table "${sTable.name}" does NOT exist on target.`);
            continue;
        }

        const countRows = async (api, tableId) => {
            let count = 0;
            let cursor;
            do {
                const query = new URLSearchParams({ limit: '100' });
                if (cursor) query.set('cursor', cursor);
                const page = await api.request(`data-tables/${tableId}/rows?${query}`);
                count += (page.data || []).length;
                cursor = page.nextCursor;
            } while (cursor);
            return count;
        };

        const [sRows, tRows] = await Promise.all([
            countRows(sourceApi, sTable.id),
            countRows(targetApi, tTable.id)
        ]);

        const match = sRows === tRows;
        console.log(`[${match ? 'MATCH' : 'MISMATCH'}] "${sTable.name}": Source ${sRows} rows | Target ${tRows} rows`);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const hasFlag = flag => args.includes(flag);
    const getArg = flag => {
        const idx = args.indexOf(flag);
        return idx !== -1 ? args[idx + 1] : undefined;
    };

    const sourceUrl = process.env.SOURCE_N8N_API_URL || process.env.REMOTE_N8N_API_URL;
    const sourceKey = process.env.SOURCE_N8N_API_KEY || process.env.REMOTE_N8N_API_KEY;
    const targetUrl = process.env.TARGET_N8N_API_URL || process.env.REMOTE_N8N_API_URL;
    const targetKey = process.env.TARGET_N8N_API_KEY || process.env.REMOTE_N8N_API_KEY;

    if (hasFlag('--export')) {
        const outputDir = getArg('--export') || path.resolve(__dirname, 'data-tables-backup');
        if (!sourceUrl || !sourceKey) {
            throw new Error('SOURCE_N8N_API_URL and SOURCE_N8N_API_KEY are required for export');
        }
        const sourceApi = createApi({ apiUrl: sourceUrl, apiKey: sourceKey });
        await exportTables({ sourceApi, outputDir });
    } else if (hasFlag('--import')) {
        const inputDir = getArg('--import') || path.resolve(__dirname, 'data-tables-backup');
        if (!targetUrl || !targetKey) {
            throw new Error('TARGET_N8N_API_URL and TARGET_N8N_API_KEY are required for import');
        }
        const targetApi = createApi({ apiUrl: targetUrl, apiKey: targetKey });
        await importTables({ targetApi, inputDir, dryRun: hasFlag('--dry-run') });
    } else if (hasFlag('--verify')) {
        if (!sourceUrl || !sourceKey || !targetUrl || !targetKey) {
            throw new Error('Both SOURCE and TARGET credentials are required for verify');
        }
        const sourceApi = createApi({ apiUrl: sourceUrl, apiKey: sourceKey });
        const targetApi = createApi({ apiUrl: targetUrl, apiKey: targetKey });
        await verifyTables({ sourceApi, targetApi });
    } else {
        console.log(`Usage:
  Export: node migration/migrate-data-tables.js --export [output_dir]
  Import: node migration/migrate-data-tables.js --import [input_dir] [--dry-run]
  Verify: node migration/migrate-data-tables.js --verify
`);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Data table migration failed:', err.message);
        process.exitCode = 1;
    });
}

module.exports = { exportTables, importTables, verifyTables };
