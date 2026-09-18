const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { safeExternalPath } = require('./sync-utils');

function assertCleanDirectory(directory, cwd = process.cwd()) {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', directory], { cwd, encoding: 'utf8' });
    if (status.trim()) throw new Error(`Local changes would be overwritten: ${directory}`);
}

// Preserve baseline object key order while consistently pretty-printing JSON.
function renderWorkflow(value, original) {
    const baseline = original ? JSON.parse(original) : undefined;
    function orderKeys(current, previous) {
        if (!current || typeof current !== 'object') return current;
        if (Array.isArray(current)) {
            return current.map((entry, i) => orderKeys(entry, Array.isArray(previous) ? previous[i] : undefined));
        }
        const prior = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
        const keys = [...new Set([...Object.keys(prior).filter(key => Object.hasOwn(current, key)), ...Object.keys(current)])];
        return Object.fromEntries(keys.map(key => [key, orderKeys(current[key], Object.hasOwn(prior, key) ? prior[key] : undefined)]));
    }
    return JSON.stringify(orderKeys(value, baseline), null, 2) + '\n';
}

function applyFilePlan(directory, files, { beforeWrite = () => {}, remove = [] } = {}) {
    const changes = [];
    for (const [relative, content] of files) {
        const absolute = safeExternalPath(directory, relative);
        const previous = fs.existsSync(absolute) ? fs.readFileSync(absolute) : null;
        if (previous?.equals(Buffer.from(content))) continue;
        changes.push({ relative, absolute, previous, content });
    }
    for (const relative of remove) {
        if (files.has(relative)) throw new Error('Cannot remove a planned file');
        const absolute = safeExternalPath(directory, relative);
        if (fs.existsSync(absolute)) changes.push({ relative, absolute, previous: fs.readFileSync(absolute), content: null });
    }
    if (!changes.length) return { changed: 0 };
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-sync-rollback-'));
    for (const change of changes) {
        if (change.previous !== null) {
            const backup = path.join(backupDir, change.relative);
            fs.mkdirSync(path.dirname(backup), { recursive: true });
            fs.writeFileSync(backup, change.previous, { mode: 0o600 });
        }
    }
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ directory, files: changes.map(c => ({ path: c.relative, existed: c.previous !== null })) }, null, 2));
    const written = [];
    try {
        for (const change of changes) {
            beforeWrite(change.relative);
            const current = fs.existsSync(change.absolute) ? fs.readFileSync(change.absolute) : null;
            if (!isDeepStrictEqual(current, change.previous)) throw new Error('Local file changed during sync');
            if (change.content === null) fs.unlinkSync(change.absolute);
            else {
                fs.mkdirSync(path.dirname(change.absolute), { recursive: true });
                const temporary = change.absolute + `.sync-${process.pid}`;
                try {
                    fs.writeFileSync(temporary, change.content, { flag: 'wx' });
                    fs.renameSync(temporary, change.absolute);
                } finally {
                    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
                }
            }
            written.push(change);
        }
    } catch (error) {
        for (const change of written.reverse()) {
            if (change.previous === null) fs.unlinkSync(change.absolute);
            else fs.writeFileSync(change.absolute, change.previous);
        }
        error.message += `; rollback backup: ${backupDir}`;
        throw error;
    }
    for (const change of changes.filter(item => item.content === null)) {
        let parent = path.dirname(change.absolute);
        while (parent !== path.resolve(directory) && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
            fs.rmdirSync(parent);
            parent = path.dirname(parent);
        }
    }
    return { changed: changes.length, backupDir };
}

module.exports = { assertCleanDirectory, renderWorkflow, applyFilePlan };
