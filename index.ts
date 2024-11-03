import { compare, parse } from "@std/semver";

const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN');

if (!GITHUB_TOKEN) {
    console.error('No GITHUB_TOKEN value provided');
    Deno.exit(1);
}

const noCache = Deno.args.includes('--no-cache');

interface Release {
    created_at: string;
    name: string;
    tag_name: string;
}

interface VsCode {
    created_at: string;
    electron: string;
    name: string;
    node: string;
    chromium: string;
    version: string;
}

/**
 * Parses the link header value in order to retrieve the next link value for pagination
 *
 * @param {string} header - The link header from the response
 * @returns {string|undefined} - The next link value if one exists
 */
function parseLinkHeader (header: string): string|undefined {
    let nextLink: string|undefined;
    for (const part of header.split(/,\s*</)) {
        const [ link, rel ] = part.split(/;\s*/);
        if (!rel.includes('next')) {
            continue;
        }

        nextLink = link.match(/<(.*)>/)?.[1];
    }
    return nextLink;
}

/**
 * Performs a GitHub API request handling pagination and authentication
 *
 * @template T
 * @param {string} uri - The URI to request
 * @returns {T[]} The response from the GitHub API
 */
async function githubApiRequest<T extends Array<unknown>>(uri: string): Promise<T> {
    const response = await fetch(uri, {
        headers: new Headers({
            'User-Agent': 'vscode-versions',
            'Authorization': `token ${GITHUB_TOKEN}`
        })
    });

    const data = await response.json() as T;

    const linkHeader = response.headers.get('link');
    if (linkHeader) {
        const nextLink = parseLinkHeader(linkHeader);
        if (nextLink) {
            data.push(...(await githubApiRequest<T>(nextLink)));
        }
    }

    return data;
}

/**
 * Request a file on GitHub
 *
 * @param {string} uri - The URI to request
 * @returns {Promise<string>} The file contents
 */
async function githubFileRequest(uri: string): Promise<string> {
    const response = await fetch(uri, {
        headers: new Headers({
            'User-Agent': 'vscode-versions',
            'Authorization': `token ${GITHUB_TOKEN}`
        })
    });

    if (response.status >= 400) {
        console.error(`Failed to get text for ${uri}`);
        throw new Error(await response.text());
    }

    return response.text();
}

/**
 * Looks up the Electron version included in the VS Code version
 *
 * @param {string} version - The VS Code version
 * @returns {Promise<string>} The Electron version
 */
async function getElectronVersion (version: string): Promise<string> {
    let electronVersion = 'Unknown';
    let rcFile
    try {
        // newer versions moved to .npmrc
        rcFile = await githubFileRequest(`https://raw.githubusercontent.com/Microsoft/vscode/${version}/.npmrc`);
    } catch (_) {
        // older versions used .yarnrc
        rcFile = await githubFileRequest(`https://raw.githubusercontent.com/Microsoft/vscode/${version}/.yarns`);
    }

  
    const target = rcFile.match(/target[ =]"(\d.*)"/);
    if (target && target[1]) {
        electronVersion = target[1];
    }
    return electronVersion;
}

/**
 * Looks up the Chromium version included in the Electron version used in VS Code
 *
 * @param electronVersion - The Electron version used in VS Code
 * @returns {Promise<string>} The Chromium version
 */
async function getChromiumVersion (electronVersion: string): Promise<string> {
    let chromiumVersion = 'Unknown';
    const file = await githubFileRequest(`https://raw.githubusercontent.com/electron/electron/v${electronVersion}/DEPS`)
    const version = file.match(/'chromium_version':\s+'(\d.*)'/);
    if (version && version.length > 1) {
        chromiumVersion = version[1];
    }

    return chromiumVersion;
}

/**
 * Looks up the Node.js version included in the Electron version in VS Code
 *
 * @param {string} electronVersion - The Electron version used in VS Code
 * @returns {Promise<string>} The Node.js version
 */
async function getNodeVersion(electronVersion: string): Promise<string> {
    let nodeVersion = 'Unknown';
    
    const file = await githubFileRequest(`https://raw.githubusercontent.com/electron/electron/v${electronVersion}/DEPS`)
    const version = file.match(/'node_version':\s+'(v\d.*)'/);
    const versionOrSha = version?.[1];

    if (versionOrSha?.startsWith('v')) {
        nodeVersion = versionOrSha.substring(1);
    }
    return nodeVersion;
}

/**
 * Read the cached versions
 *
 * @returns {Promise<VsCode[]>} A promise which will resolve with an array of cached versions or
 * an empty array if --no-cache was provided
 */
async function getCachedVersions (): Promise<VsCode[]> {
    if (noCache) {
        return []
    }
    return JSON.parse(await Deno.readTextFile('./versions.json'));
}

async function getVsCodeVersions () {
    const versions = await getCachedVersions();
    const cachedVersions = versions.map(vscode => vscode.version);
    const releases = await githubApiRequest<Release[]>('https://api.github.com/repos/Microsoft/vscode/releases');
    for (const release of releases) {
        const { name, tag_name, created_at } = release;
        if (!noCache && cachedVersions.includes(tag_name)) {
            console.log(`Already have data for ${tag_name}`);
            continue;
        }
        console.log(`Get versions for ${tag_name}`);
        const electron = await getElectronVersion(tag_name);

        const [ chromium, node ] = await Promise.all([
            getChromiumVersion(electron),
            getNodeVersion(electron)
        ])

        versions.push({
            version: tag_name,
            chromium,
            electron,
            node,
            name,
            created_at
        });
    }
    // reverse sort to ensure we have latest versions at the top
    return versions.sort((a,b) => compare(parse(b.version), parse(a.version)));
}

const versions = await getVsCodeVersions();
await Deno.writeTextFile('./versions.json', JSON.stringify(versions, undefined, '  '));

await Deno.writeTextFile('./README.md', `# VS Code Versions

An overview of the Electron, Node.js, and Chromium version in each VS Code release.

Last updated: ${new Date().toISOString()}

|VS Code|Codename|Electron|Node|Chromium|
|:-------:|:--------:|:--------:|:----:|:------:|
${
    versions.map(version => (
        `|[${version.version}](https://github.com/microsoft/vscode/releases/tag/${version.version})|${version.name}|${version.electron}|${version.node}|${version.chromium}|`
    )).join('\n')
}

## How it works

The scripts works by doing the following:

1. Retrieve all the releases in the microsoft/vscode repo
2. For each release
   - Retrieve the Electron version in VS Code
   - Retrieve the Chromium and Node.js versions in Electron
3. Update the README file

## Running locally

1. [Install Deno](https://deno.land/#installation)
2. Create a .env file based on the .env.example file
3. Run using \`deno task run\`

\`:bulb: If you need to update the cache provide the --no-cache flag after index.ts\`
`);