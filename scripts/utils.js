const fs = require('fs');
const path = require('path');

function resolveExternalFiles(obj, baseDir) {
    if (typeof obj === 'string') {
        if (obj.startsWith('__EXTERNAL_FILE__://')) {
            const relPath = obj.replace('__EXTERNAL_FILE__://', '');
            const absPath = path.join(baseDir, relPath);
            return fs.readFileSync(absPath, 'utf8');
        }
        return obj;
    } else if (Array.isArray(obj)) {
        return obj.map(item => resolveExternalFiles(item, baseDir));
    } else if (obj !== null && typeof obj === 'object') {
        const newObj = {};
        for (const [key, value] of Object.entries(obj)) {
            newObj[key] = resolveExternalFiles(value, baseDir);
        }
        return newObj;
    }
    return obj;
}

function buildWorkflow(dirPath) {
    const wfPath = path.join(dirPath, 'workflow.json');
    if (!fs.existsSync(wfPath)) {
        throw new Error(`workflow.json not found in ${dirPath}`);
    }
    const wfData = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
    return resolveExternalFiles(wfData, dirPath);
}

// Allow running from CLI for verification purposes
if (require.main === module) {
    const targetDir = process.argv[2];
    if (targetDir) {
        console.log(JSON.stringify(buildWorkflow(path.resolve(targetDir)), null, 2));
    }
}

module.exports = { buildWorkflow, resolveExternalFiles };
