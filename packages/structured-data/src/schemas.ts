/**
 * Built-in schemas for common configuration files, matched by file name. They give the visual
 * editor understandable fields (titles, descriptions, choices) and validation.
 */
import type { Schema } from './schema';

const str = (title: string, description?: string, extra: Partial<Schema> = {}): Schema => ({ type: 'string', title, ...(description ? { description } : {}), ...extra });
const bool = (title: string, description?: string, extra: Partial<Schema> = {}): Schema => ({ type: 'boolean', title, ...(description ? { description } : {}), ...extra });
const list = (title: string, items: Schema, description?: string, extra: Partial<Schema> = {}): Schema => ({ type: 'array', title, items, ...(description ? { description } : {}), ...extra });
const map = (title: string, value: Schema, description?: string, extra: Partial<Schema> = {}): Schema => ({ type: 'object', title, additionalProperties: value, ...(description ? { description } : {}), ...extra });
const choice = (title: string, values: string[], description?: string, extra: Partial<Schema> = {}): Schema => ({ type: 'string', title, enum: values, ...(description ? { description } : {}), ...extra });

const versionRange = str('Version', 'Which versions are accepted, e.g. ^1.2.0 (1.x from 1.2.0), ~1.2.0, 1.2.3, * or latest', { format: 'version-range' });

export const PACKAGE_JSON: Schema = {
  type: 'object',
  title: 'package.json',
  description: 'The npm manifest: the project name, its scripts and the packages it uses.',
  properties: {
    name: str('Package name', 'Lower-case, no spaces (used if you publish to npm)', { pattern: '^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$', patternMessage: 'Lower-case letters, digits, - . _ ~ only (optionally @scope/name)', group: 'General' }),
    version: str('Version', undefined, { format: 'semver', default: '0.1.0', group: 'General' }),
    description: str('Description', undefined, { group: 'General' }),
    private: bool('Private', "Don't allow publishing to npm by accident", { group: 'General' }),
    type: choice('Module system', ['module', 'commonjs'], '"module" = import/export (modern); "commonjs" = require()', { enumLabels: ['ES modules (import/export)', 'CommonJS (require)'], group: 'General' }),
    main: str('Entry file', 'The file other packages get when they import this one', { group: 'General', advanced: true }),
    license: str('Licence', 'e.g. MIT, Apache-2.0, ISC, UNLICENSED', { group: 'General', advanced: true }),
    author: { anyOf: [str('Author'), { type: 'object', title: 'Author', properties: { name: str('Name'), email: str('Email', undefined, { format: 'email' }), url: str('Website', undefined, { format: 'uri' }) } }], group: 'General', advanced: true },
    homepage: str('Homepage', undefined, { format: 'uri', advanced: true, group: 'General' }),
    keywords: list('Keywords', str('Keyword'), undefined, { advanced: true, group: 'General' }),
    scripts: map('Scripts', str('Command'), 'Commands you can run, e.g. "dev" starts the dev server. Run them with the Computer panel or in GitHub Actions.', { keyTitle: 'Script', group: 'Scripts', keySuggestions: [{ key: 'dev', value: 'vite', description: 'Start the dev server' }, { key: 'build', value: 'vite build', description: 'Build for production' }, { key: 'preview', value: 'vite preview' }, { key: 'test', value: 'vitest run', description: 'Run the tests' }, { key: 'typecheck', value: 'tsc --noEmit' }, { key: 'lint', value: 'eslint .' }, { key: 'deploy', value: 'wrangler deploy', description: 'Deploy to Cloudflare' }] }),
    dependencies: map('Dependencies', versionRange, 'Packages the app needs at run time. (The Packages tab can search npm and add them.)', { keyTitle: 'Package', group: 'Dependencies' }),
    devDependencies: map('Dev dependencies', versionRange, 'Packages only needed to build and test (Vite, TypeScript, test runners…)', { keyTitle: 'Package', group: 'Dependencies' }),
    peerDependencies: map('Peer dependencies', versionRange, 'Packages the user of this package must install', { keyTitle: 'Package', group: 'Dependencies', advanced: true }),
    engines: map('Engines', versionRange, 'Required Node / npm versions', { group: 'Dependencies', advanced: true, keySuggestions: [{ key: 'node', value: '>=20' }] }),
  },
};

export const TSCONFIG: Schema = {
  type: 'object',
  title: 'TypeScript settings',
  description: 'How TypeScript checks and compiles the project.',
  properties: {
    extends: str('Extends', 'Another tsconfig to start from', { advanced: true, group: 'General' }),
    compilerOptions: {
      type: 'object',
      title: 'Compiler options',
      group: 'Compiler',
      properties: {
        target: choice('Target', ['ES2015', 'ES2017', 'ES2018', 'ES2019', 'ES2020', 'ES2021', 'ES2022', 'ES2023', 'ESNext'], 'Which JavaScript version to produce (ES2022 runs in every current browser)'),
        module: choice('Module', ['ESNext', 'ES2022', 'NodeNext', 'Node16', 'CommonJS', 'Preserve'], 'How imports are written in the output'),
        moduleResolution: choice('Module resolution', ['bundler', 'NodeNext', 'Node16', 'node'], 'How imports are found: "bundler" for Vite/esbuild, NodeNext for Node'),
        lib: list('Built-in libraries', choice('Library', ['ES2022', 'ES2023', 'ESNext', 'DOM', 'DOM.Iterable', 'WebWorker']), 'Which built-in APIs exist (DOM = browser)'),
        jsx: choice('JSX', ['react-jsx', 'react-jsxdev', 'preserve', 'react'], 'How JSX (React elements) is compiled'),
        strict: bool('Strict', 'Catch more mistakes (recommended)'),
        noEmit: bool("Don't write output", 'Only check types (a bundler builds the code)'),
        outDir: str('Output folder', undefined, { format: 'path' }),
        rootDir: str('Source folder', undefined, { format: 'path', advanced: true }),
        baseUrl: str('Base folder for imports', undefined, { advanced: true }),
        paths: map('Import aliases', list('Targets', str('Path')), 'e.g. "@/*" → ["src/*"]', { keyTitle: 'Alias', advanced: true }),
        types: list('Type packages', str('Package'), 'Only these @types packages are loaded', { advanced: true }),
        skipLibCheck: bool("Don't check library types", 'Faster; skips errors inside node_modules'),
        esModuleInterop: bool('Default imports from CommonJS', undefined, { advanced: true }),
        isolatedModules: bool('Isolated modules', 'Required by Vite / esbuild', { advanced: true }),
        resolveJsonModule: bool('Import JSON files', undefined, { advanced: true }),
        allowJs: bool('Allow JavaScript files', undefined, { advanced: true }),
        declaration: bool('Write .d.ts files', undefined, { advanced: true }),
        sourceMap: bool('Source maps', undefined, { advanced: true }),
        noUnusedLocals: bool('Error on unused variables', undefined, { advanced: true }),
        noUnusedParameters: bool('Error on unused parameters', undefined, { advanced: true }),
      },
    },
    include: list('Include', str('Pattern'), 'Files to check, e.g. "src"', { group: 'Files' }),
    exclude: list('Exclude', str('Pattern'), undefined, { group: 'Files', advanced: true }),
  },
};

const fabricDep = str('Version range', 'e.g. >=0.16.0, ~1.21.1, * (any)');
export const FABRIC_MOD_JSON: Schema = {
  type: 'object',
  title: 'Fabric mod',
  description: 'fabric.mod.json: tells Fabric Loader what your mod is and how to start it.',
  required: ['schemaVersion', 'id', 'version'],
  properties: {
    schemaVersion: { type: 'number', title: 'Schema version', enum: [1], default: 1, description: 'Always 1', group: 'Mod', advanced: true },
    id: str('Mod ID', 'Unique id: lower-case letters, digits, - or _, 2–64 characters (e.g. mymod)', { format: 'identifier', pattern: '^[a-z][a-z0-9_-]{1,63}$', patternMessage: '2–64 lower-case letters, digits, - or _, starting with a letter', group: 'Mod' }),
    version: str('Version', 'e.g. 1.0.0 (or ${version} to take it from gradle.properties)', { group: 'Mod' }),
    name: str('Name', 'Shown in the mod list', { group: 'Mod' }),
    description: str('Description', undefined, { group: 'Mod' }),
    authors: list('Authors', { anyOf: [str('Author'), { type: 'object', title: 'Author', properties: { name: str('Name'), contact: map('Contact', str('Value')) } }] }, undefined, { group: 'Mod' }),
    contributors: list('Contributors', str('Name'), undefined, { group: 'Mod', advanced: true }),
    license: str('Licence', 'e.g. MIT, LGPL-3.0, All-Rights-Reserved', { group: 'Mod' }),
    icon: str('Icon', 'Path inside the mod, e.g. assets/mymod/icon.png', { format: 'path', group: 'Mod' }),
    environment: choice('Runs on', ['*', 'client', 'server'], undefined, { enumLabels: ['Client and server', 'Client only', 'Server only'], default: '*', group: 'Mod' }),
    contact: { type: 'object', title: 'Links', group: 'Mod', properties: { homepage: str('Homepage', undefined, { format: 'uri' }), sources: str('Source code', undefined, { format: 'uri' }), issues: str('Issue tracker', undefined, { format: 'uri' }), email: str('Email', undefined, { format: 'email' }) } },
    entrypoints: map('Entry points', list('Classes', str('Class', 'Fully qualified class, e.g. com.example.mymod.MyMod', { format: 'class-name' })), 'Which classes Fabric starts: "main" runs on both sides, "client" only on the client', { keyTitle: 'Kind', group: 'Start-up', keySuggestions: [{ key: 'main', value: [] }, { key: 'client', value: [] }, { key: 'server', value: [] }, { key: 'fabric-datagen', value: [] }] }),
    mixins: list('Mixin configs', { anyOf: [str('Config file', 'e.g. mymod.mixins.json'), { type: 'object', title: 'Config', properties: { config: str('Config file'), environment: choice('Runs on', ['*', 'client', 'server']) } }] }, undefined, { group: 'Start-up' }),
    accessWidener: str('Access widener', 'e.g. mymod.accesswidener', { group: 'Start-up', advanced: true }),
    depends: map('Requires', fabricDep, 'Mods (and versions) that must be installed', { keyTitle: 'Mod', group: 'Dependencies', keySuggestions: [{ key: 'fabricloader', value: '>=0.16.0', description: 'Fabric Loader' }, { key: 'minecraft', value: '~1.21.1', description: 'Minecraft' }, { key: 'java', value: '>=21', description: 'Java' }, { key: 'fabric-api', value: '*', description: 'Fabric API' }] }),
    recommends: map('Recommends', fabricDep, undefined, { keyTitle: 'Mod', group: 'Dependencies', advanced: true }),
    suggests: map('Suggests', fabricDep, undefined, { keyTitle: 'Mod', group: 'Dependencies', advanced: true }),
    breaks: map('Breaks with', fabricDep, 'Mods this one does not work with', { keyTitle: 'Mod', group: 'Dependencies', advanced: true }),
    conflicts: map('Conflicts', fabricDep, undefined, { keyTitle: 'Mod', group: 'Dependencies', advanced: true }),
    custom: { type: 'object', title: 'Custom data', group: 'Advanced', advanced: true },
  },
};

const neoDependency: Schema = {
  type: 'object',
  title: 'Dependency',
  required: ['modId', 'type'],
  properties: {
    modId: str('Mod ID', 'e.g. neoforge or minecraft'),
    type: choice('Type', ['required', 'optional', 'incompatible', 'discouraged'], undefined, { default: 'required' }),
    versionRange: str('Versions', 'Maven range: [21.1,) = 21.1 or newer, [1.21.1,1.22) = 1.21.1 up to 1.22'),
    ordering: choice('Load order', ['NONE', 'BEFORE', 'AFTER'], undefined, { default: 'NONE' }),
    side: choice('Side', ['BOTH', 'CLIENT', 'SERVER'], undefined, { default: 'BOTH' }),
  },
};
export const NEOFORGE_MODS_TOML: Schema = {
  type: 'object',
  title: 'NeoForge mod',
  description: 'neoforge.mods.toml: tells NeoForge what your mod is and what it needs.',
  required: ['modLoader', 'loaderVersion', 'license', 'mods'],
  properties: {
    modLoader: str('Mod loader', 'javafml for normal Java mods', { default: 'javafml', group: 'Loader', advanced: true }),
    loaderVersion: str('Loader version', 'e.g. [4,)', { default: '[4,)', group: 'Loader' }),
    license: str('Licence', 'e.g. MIT, All Rights Reserved', { group: 'Loader' }),
    issueTrackerURL: str('Issue tracker', undefined, { format: 'uri', group: 'Loader', advanced: true }),
    mods: list('Mods', {
      type: 'object',
      title: 'Mod',
      required: ['modId'],
      properties: {
        modId: str('Mod ID', 'Lower-case letters, digits and _ (2–64 characters)', { pattern: '^[a-z][a-z0-9_]{1,63}$', patternMessage: '2–64 lower-case letters, digits or _, starting with a letter' }),
        version: str('Version', 'e.g. 1.0.0 or ${file.jarVersion}'),
        displayName: str('Name'),
        description: str('Description'),
        authors: str('Authors'),
        credits: str('Credits'),
        logoFile: str('Logo', 'e.g. logo.png', { format: 'path' }),
        displayURL: str('Website', undefined, { format: 'uri' }),
      },
    }, undefined, { minItems: 1, group: 'Mods' }),
    dependencies: map('Dependencies', list('Dependencies', neoDependency), 'For each of your mods (by Mod ID): what it needs', { keyTitle: 'Your mod', group: 'Dependencies' }),
    mixins: list('Mixins', { type: 'object', title: 'Mixin', properties: { config: str('Config file', 'e.g. mymod.mixins.json') } }, undefined, { group: 'Mods', advanced: true }),
  },
};

export const GRADLE_PROPERTIES: Schema = {
  type: 'object',
  title: 'Gradle properties',
  description: 'Versions and settings the Gradle build reads (Minecraft, loader and mod versions).',
  additionalProperties: str('Value'),
  keyTitle: 'Property',
  properties: {
    minecraft_version: str('Minecraft version', 'e.g. 1.21.1', { group: 'Minecraft' }),
    yarn_mappings: str('Yarn mappings', 'Fabric: e.g. 1.21.1+build.3', { group: 'Minecraft', advanced: true }),
    loader_version: str('Fabric Loader version', 'e.g. 0.16.5', { group: 'Minecraft', advanced: true }),
    fabric_version: str('Fabric API version', 'e.g. 0.105.0+1.21.1', { group: 'Minecraft', advanced: true }),
    neo_version: str('NeoForge version', 'e.g. 21.1.66', { group: 'Minecraft', advanced: true }),
    mod_version: str('Mod version', undefined, { group: 'Mod' }),
    maven_group: str('Maven group', 'e.g. com.example', { format: 'java-package', group: 'Mod' }),
    archives_base_name: str('Jar name', undefined, { group: 'Mod', advanced: true }),
    mod_id: str('Mod ID', undefined, { group: 'Mod', advanced: true }),
    'org.gradle.jvmargs': str('JVM memory', 'e.g. -Xmx2G', { group: 'Gradle', advanced: true }),
  },
};

const mavenDep: Schema = {
  type: 'object',
  title: 'Dependency',
  required: ['groupId', 'artifactId'],
  properties: { groupId: str('Group', 'e.g. org.junit.jupiter'), artifactId: str('Artifact', 'e.g. junit-jupiter'), version: str('Version'), scope: choice('Scope', ['compile', 'provided', 'runtime', 'test', 'system', 'import'], 'When it is needed (test = only for tests)') },
};
export const POM_XML: Schema = {
  type: 'object',
  title: 'Maven project',
  properties: {
    project: {
      type: 'object',
      title: 'Project',
      required: ['modelVersion', 'groupId', 'artifactId', 'version'],
      properties: {
        modelVersion: str('Model version', 'Always 4.0.0', { default: '4.0.0', advanced: true }),
        groupId: str('Group', 'Your organisation, reversed domain style: com.example', { format: 'java-package' }),
        artifactId: str('Artifact', 'The project name, e.g. my-app'),
        version: str('Version', 'e.g. 1.0-SNAPSHOT'),
        packaging: choice('Packaging', ['jar', 'pom', 'war'], undefined, { default: 'jar' }),
        name: str('Name'),
        description: str('Description'),
        properties: map('Properties', str('Value'), 'Settings like the Java version', { keyTitle: 'Property', keySuggestions: [{ key: 'maven.compiler.release', value: '21', description: 'Java version' }, { key: 'project.build.sourceEncoding', value: 'UTF-8' }] }),
        dependencies: { type: 'object', title: 'Dependencies', properties: { dependency: { anyOf: [list('Dependencies', mavenDep), mavenDep] } } },
        build: { type: 'object', title: 'Build', advanced: true },
      },
    },
  },
};

export const CSPROJ: Schema = {
  type: 'object',
  title: '.NET project',
  properties: {
    Project: {
      type: 'object',
      title: 'Project',
      properties: {
        '@Sdk': str('SDK', 'Microsoft.NET.Sdk for apps and libraries', { default: 'Microsoft.NET.Sdk' }),
        PropertyGroup: {
          anyOf: [
            {
              type: 'object',
              title: 'Settings',
              properties: {
                OutputType: choice('Output', ['Exe', 'Library', 'WinExe'], 'Exe = a program, Library = a .dll for others'),
                TargetFramework: str('Framework', 'e.g. net8.0 (or netstandard2.1 for Unity)'),
                RootNamespace: str('Namespace'),
                Nullable: choice('Nullable checks', ['enable', 'disable']),
                ImplicitUsings: choice('Implicit usings', ['enable', 'disable']),
                LangVersion: str('C# version', 'e.g. latest, 12.0', { advanced: true }),
              },
            },
            list('Settings groups', { type: 'object' }),
          ],
        },
        ItemGroup: { anyOf: [{ type: 'object', title: 'Items', properties: { PackageReference: { anyOf: [list('NuGet packages', { type: 'object', title: 'Package', properties: { '@Include': str('Package'), '@Version': str('Version') } }), { type: 'object', title: 'Package', properties: { '@Include': str('Package'), '@Version': str('Version') } }] } } }, list('Item groups', { type: 'object' })] },
      },
    },
  },
};

export const PYPROJECT: Schema = {
  type: 'object',
  title: 'Python project',
  description: 'pyproject.toml: the project, its Python version and its dependencies.',
  properties: {
    project: {
      type: 'object',
      title: 'Project',
      group: 'Project',
      required: ['name'],
      properties: {
        name: str('Name', 'e.g. my-tool'),
        version: str('Version', undefined, { default: '0.1.0' }),
        description: str('Description'),
        readme: str('Readme', undefined, { default: 'README.md' }),
        'requires-python': str('Python version', 'e.g. >=3.11'),
        license: { anyOf: [str('Licence'), { type: 'object', title: 'Licence', properties: { text: str('Text') } }] },
        authors: list('Authors', { type: 'object', title: 'Author', properties: { name: str('Name'), email: str('Email', undefined, { format: 'email' }) } }),
        dependencies: list('Dependencies', str('Requirement', 'e.g. requests>=2.31')),
        'optional-dependencies': map('Optional dependencies', list('Requirements', str('Requirement')), 'Groups like "dev" or "test"', { keyTitle: 'Group' }),
        scripts: map('Commands', str('Function', 'module:function, e.g. my_tool.cli:main'), 'Command-line commands this installs', { keyTitle: 'Command' }),
      },
    },
    'build-system': { type: 'object', title: 'Build system', group: 'Build', properties: { requires: list('Requires', str('Requirement'), undefined, { default: ['hatchling'] }), 'build-backend': str('Backend', 'e.g. hatchling.build', { default: 'hatchling.build' }) } },
    tool: { type: 'object', title: 'Tools', group: 'Tools', advanced: true },
  },
};

export const GITHUB_WORKFLOW: Schema = {
  type: 'object',
  title: 'GitHub Actions workflow',
  required: ['on', 'jobs'],
  properties: {
    name: str('Name'),
    on: { anyOf: [str('Trigger'), list('Triggers', choice('Event', ['push', 'pull_request', 'workflow_dispatch', 'release', 'schedule'])), { type: 'object', title: 'Triggers', additionalProperties: { type: ['object', 'null'] } }], title: 'Runs on' },
    permissions: map('Permissions', choice('Access', ['read', 'write', 'none'])),
    env: map('Environment variables', str('Value'), undefined, { keyTitle: 'Variable' }),
    jobs: map('Jobs', {
      type: 'object',
      title: 'Job',
      properties: {
        name: str('Name'),
        'runs-on': str('Machine', 'e.g. ubuntu-latest', { default: 'ubuntu-latest' }),
        needs: { anyOf: [str('Needs'), list('Needs', str('Job'))] },
        steps: list('Steps', { type: 'object', title: 'Step', properties: { name: str('Name'), uses: str('Action', 'e.g. actions/checkout@v4'), run: str('Command'), with: map('Inputs', { type: ['string', 'number', 'boolean'] }, undefined, { keyTitle: 'Input' }), env: map('Environment', str('Value')) } }),
      },
    }, undefined, { keyTitle: 'Job id' }),
  },
};

export const WRANGLER: Schema = {
  type: 'object',
  title: 'Cloudflare Worker',
  properties: {
    name: str('Worker name'),
    main: str('Entry file', 'e.g. src/index.ts'),
    compatibility_date: str('Compatibility date', 'e.g. 2025-01-01'),
    assets: { type: 'object', title: 'Static files', properties: { directory: str('Folder', 'e.g. ./dist'), not_found_handling: choice('Missing pages', ['single-page-application', '404-page', 'none']) } },
    vars: map('Variables', str('Value'), 'Plain settings (never secrets)', { keyTitle: 'Name' }),
  },
};

export const UNITY_MANIFEST: Schema = { type: 'object', title: 'Unity packages', properties: { dependencies: map('Packages', str('Version'), undefined, { keyTitle: 'Package' }) } };

const RULES: [RegExp, Schema][] = [
  [/(^|\/)package\.json$/, PACKAGE_JSON],
  [/(^|\/)(tsconfig|jsconfig)(\.[\w-]+)?\.json$/, TSCONFIG],
  [/(^|\/)fabric\.mod\.json$/, FABRIC_MOD_JSON],
  [/(^|\/)(neoforge\.)?mods\.toml$/, NEOFORGE_MODS_TOML],
  [/(^|\/)gradle\.properties$/, GRADLE_PROPERTIES],
  [/(^|\/)pom\.xml$/, POM_XML],
  [/\.csproj$/, CSPROJ],
  [/(^|\/)pyproject\.toml$/, PYPROJECT],
  [/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/, GITHUB_WORKFLOW],
  [/(^|\/)wrangler\.jsonc?$/, WRANGLER],
  [/(^|\/)Packages\/manifest\.json$/, UNITY_MANIFEST],
];

/** The built-in schema for a file, if there is one. */
export function schemaFor(path: string): Schema | undefined {
  return RULES.find(([re]) => re.test(path))?.[1];
}
