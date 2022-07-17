import "https://deno.land/x/dotenv@v3.2.0/load.ts";

const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN');

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
 * @param uri - The URI to request
 * @returns ?
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
 * @param {String} uri - The URI to request
 * @returns {String} The file contents
 */
async function githubFileRequest(uri: string): Promise<string> {
    const response = await fetch(uri, {
        headers: new Headers({
            'User-Agent': 'vscode-versions',
            'Authorization': `token ${GITHUB_TOKEN}`
        })
    });

    if (response.status >= 400) {
        throw new Error(await response.text());
    }

    return response.text();
}

async function getElectronVersion (version: string): Promise<string> {
    let electronVersion = 'Unknown';
    const yarnrc = await githubFileRequest(`https://raw.githubusercontent.com/Microsoft/vscode/${version}/.yarnrc`);
    const target = yarnrc.match(/target "(\d.*)"/);
    if (target && target[1]) {
        electronVersion = target[1];
    }
    return electronVersion;
}

async function getChromiumVersion (electronVersion: string): Promise<string> {
    let chromiumVersion = 'Unknown';
    const file = await githubFileRequest(`https://raw.githubusercontent.com/electron/electron/v${electronVersion}/DEPS`)
    const version = file.match(/'chromium_version':\s+'(\d.*)'/);
    if (version && version.length > 1) {
        chromiumVersion = version[1];
    }

    return chromiumVersion;
}

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

async function getVsCodeVersions () {
    const versions: VsCode[] = JSON.parse(await Deno.readTextFile('./versions.json'));
    const cachedVersions = versions.map(vscode => vscode.version);
    const releases = await githubApiRequest<Release[]>('https://api.github.com/repos/Microsoft/vscode/releases');
    for (const release of releases) {
        const { name, tag_name, created_at } = release;
        if (cachedVersions.includes(tag_name)) {
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
    return versions;
}

const versions = await getVsCodeVersions();
await Deno.writeTextFile('./versions.json', JSON.stringify(versions, undefined, '\t'));

await Deno.writeTextFile('./README.md', `
# VS Code Versions

An overview of the Electron, Node.js, and Chromium version in each VS Code release.

Last updated: ${new Date().toISOString()}

|VS Code|Electron|Node|Chromium|
|:-------:|:--------:|:----:|:------:|
${
    versions.map(version => (
        `|${version.version}|${version.electron}|${version.node}|${version.chromium}|`
    )).join('\n')
}`);