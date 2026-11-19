const PLACEHOLDER_RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3eEXAMPLE+PLACEHOLDER+KEY+FOR+N8N+MIGRATION+ONLY
-----END RSA PRIVATE KEY-----
`;

const CREDENTIAL_DEFINITIONS = Object.freeze([
    {
        id: 'Dd7x1TQhh9YKbD8v',
        name: 'Google BigQuery account',
        type: 'googleApi',
        data: {
            email: 'placeholder-bigquery-sa@media17-1119.iam.gserviceaccount.com',
            privateKey: PLACEHOLDER_RSA_KEY
        },
        description: 'Google BigQuery Service Account for media17-1119'
    },
    {
        id: 'xCxzQVNUYMaL9Cea',
        name: 'Vertex SA',
        type: 'googleApi',
        data: {
            email: 'placeholder-vertex-sa@aiops-338206.iam.gserviceaccount.com',
            privateKey: PLACEHOLDER_RSA_KEY
        },
        description: 'Vertex AI Service Account for aiops-338206'
    },
    {
        id: 'b39tXWu6AGQsbY2C',
        name: 'Header Auth account 2',
        type: 'httpHeaderAuth',
        data: {
            name: 'Authorization',
            value: 'Bearer placeholder_stt_token'
        },
        description: 'STT API HTTP Header Authorization'
    },
    {
        id: '9sfslX7caXSFAVUN',
        name: 'n8n-streaming-testing',
        type: 'slackApi',
        data: {
            accessToken: 'xoxb-placeholder-slack-bot-token'
        },
        description: 'Slack Bot OAuth Access Token'
    },
    {
        id: 'gMeMxD0Uq89xl8xy',
        name: 'Google Gemini(PaLM) Api account',
        type: 'googlePalmApi',
        data: {
            apiKey: 'AIzaSyPlaceholderGeminiApiKey'
        },
        description: 'Google Gemini PaLM API Key'
    },
    {
        id: 'nSAb8g6cRvipp2vr',
        name: 'GDrive token',
        type: 'httpCustomAuth',
        data: {
            json: '{}'
        },
        description: 'Legacy GDrive Custom HTTP Auth'
    },
    {
        id: '8e699QSw7z2OEzw0',
        name: 'STT callback auth',
        type: 'httpBasicAuth',
        data: {
            user: 'placeholder_user',
            password: 'placeholder_password'
        },
        description: 'Legacy STT Callback Basic Auth'
    }
]);

async function provisionCredentials({ targetUrl, targetKey, dryRun = false }) {
    console.log(`=== Provisioning Placeholder Credentials on ${targetUrl} (Dry Run: ${dryRun}) ===\n`);

    const created = [];
    const skipped = [];
    const errors = [];

    for (const cred of CREDENTIAL_DEFINITIONS) {
        console.log(`Processing "${cred.name}" (ID: ${cred.id}, Type: ${cred.type})...`);

        if (dryRun) {
            console.log(`  [Dry-Run] Would create credential "${cred.name}" with ID "${cred.id}".`);
            created.push(cred);
            continue;
        }

        try {
            const res = await fetch(`${targetUrl}/api/v1/credentials`, {
                method: 'POST',
                headers: {
                    'X-N8N-API-KEY': targetKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    id: cred.id,
                    name: cred.name,
                    type: cred.type,
                    data: cred.data
                })
            });

            if (res.ok) {
                const data = await res.json();
                console.log(`  Successfully created credential "${cred.name}" (ID: ${data.id}).`);
                created.push(data);
            } else if (res.status === 400 || res.status === 409) {
                const errText = await res.text();
                if (errText.includes('already exists') || errText.includes('duplicate')) {
                    console.log(`  Credential already exists (HTTP ${res.status}). Skipping.`);
                    skipped.push(cred);
                } else {
                    console.error(`  Failed to create "${cred.name}": HTTP ${res.status} ${errText}`);
                    errors.push({ cred, error: errText });
                }
            } else {
                const errText = await res.text();
                console.error(`  Failed to create "${cred.name}": HTTP ${res.status} ${errText}`);
                errors.push({ cred, error: errText });
            }
        } catch (err) {
            console.error(`  Exception creating "${cred.name}": ${err.message}`);
            errors.push({ cred, error: err.message });
        }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Created: ${created.length}`);
    console.log(`Skipped: ${skipped.length}`);
    console.log(`Errors:  ${errors.length}`);

    if (errors.length > 0) {
        throw new Error(`Failed to provision ${errors.length} credential(s).`);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');

    const targetUrl = process.env.TARGET_N8N_API_URL || process.env.REMOTE_N8N_API_URL;
    const targetKey = process.env.TARGET_N8N_API_KEY || process.env.REMOTE_N8N_API_KEY;

    if (!targetUrl || !targetKey) {
        throw new Error('TARGET_N8N_API_URL and TARGET_N8N_API_KEY must be provided');
    }

    await provisionCredentials({ targetUrl, targetKey, dryRun });
}

if (require.main === module) {
    main().catch(err => {
        console.error('Provisioning failed:', err.message);
        process.exitCode = 1;
    });
}

module.exports = { provisionCredentials, CREDENTIAL_DEFINITIONS };
