/** Visual config editing: every format keeps comments / unrelated text, and validation explains problems. */
import { describe, expect, it } from 'vitest';
import { applyToValue, editData, formatFor, parseData, schemaFor, suggestKeys, validate, type Edit, type Format } from '@cs/structured-data';

const roundtrip = (f: Format, text: string, edits: Edit[]) => {
  const out = editData(f, text, edits);
  const want = applyToValue(parseData(f, text).value, edits);
  expect(JSON.parse(JSON.stringify(parseData(f, out).value))).toEqual(f === 'xml' ? expect.anything() : want);
  return out;
};

describe('structured data: formats', () => {
  it('detects formats by name', () => {
    expect(['a/package.json', 'x.yml', 'mods.toml', 'pom.xml', 'App.csproj', 'gradle.properties', 'x.ts'].map(formatFor)).toEqual(['json', 'yaml', 'toml', 'xml', 'xml', 'properties', undefined]);
  });

  it('JSON(C): set / insert / rename / move / delete change only what they touch; comments and indent stay', () => {
    const text = '{\n    // the app\n    "name": "app",\n    "scripts": { "dev": "vite" },\n    "keywords": ["a", "b"]\n}\n';
    const out = roundtrip('json', text, [
      { op: 'set', path: ['version'], value: '1.0.0' },
      { op: 'set', path: ['scripts', 'build'], value: 'vite build' },
      { op: 'insert', path: ['keywords'], index: 1, value: 'x' },
      { op: 'rename', path: ['name'], to: 'title' },
      { op: 'move', path: ['keywords', 0], to: 2 },
      { op: 'delete', path: ['scripts', 'dev'] },
    ]);
    expect(out).toContain('// the app');
    expect(out).toContain('    "title": "app"');
    expect(parseData('json', out).value).toEqual({ title: 'app', scripts: { build: 'vite build' }, keywords: ['x', 'b', 'a'], version: '1.0.0' });
    expect(out.endsWith('\n')).toBe(true);
    expect(editData('json', '', [{ op: 'set', path: ['a'], value: 1 }])).toBe('{\n  "a": 1\n}\n');
  });

  it('YAML: comments and layout survive edits', () => {
    const text = '# CI\nname: CI # the name\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n';
    const out = roundtrip('yaml', text, [
      { op: 'set', path: ['name'], value: 'Build' },
      { op: 'insert', path: ['jobs', 'test', 'steps'], value: { run: 'npm test' } },
      { op: 'rename', path: ['jobs', 'test'], to: 'check' },
    ]);
    expect(out).toContain('# CI\n');
    expect(out).toContain('name: Build # the name');
    expect(out).toContain('- run: npm test');
  });

  it('TOML: line-level edits keep comments in a NeoForge mods.toml; tables and [[arrays]] work', () => {
    const text = `# This is the mods.toml
modLoader="javafml" # keep me
loaderVersion="[4,)"
license="MIT"

# The mod
[[mods]]
modId="examplemod"
version="1.0.0"
displayName="Example Mod"

[[dependencies.examplemod]]
    modId="neoforge"
    type="required"
    versionRange="[21.1,)"
`;
    const out = roundtrip('toml', text, [
      { op: 'set', path: ['mods', 0, 'displayName'], value: 'My Mod' },
      { op: 'set', path: ['mods', 0, 'description'], value: 'Does things' },
      { op: 'set', path: ['dependencies', 'examplemod', 0, 'versionRange'], value: '[21.1.66,)' },
      { op: 'insert', path: ['dependencies', 'examplemod'], value: { modId: 'minecraft', type: 'required', versionRange: '[1.21.1,1.22)' } },
      { op: 'set', path: ['issueTrackerURL'], value: 'https://x.dev/issues' },
      { op: 'delete', path: ['license'] },
    ]);
    expect(out).toContain('# This is the mods.toml');
    expect(out).toContain('modLoader="javafml" # keep me');
    expect(out).toContain('# The mod');
    expect(out).toContain('displayName="My Mod"');
    expect(out).toContain('    versionRange="[21.1.66,)"');
    expect(out).toMatch(/\[\[dependencies\.examplemod\]\]\nmodId = "minecraft"/);
    expect(out).not.toContain('license');
  });

  it('TOML: new tables are appended, and anything else falls back to a correct full rewrite', () => {
    const out = roundtrip('toml', '[project]\nname = "x"\n', [{ op: 'set', path: ['build-system', 'build-backend'], value: 'hatchling.build' }, { op: 'set', path: ['project', 'authors'], value: [{ name: 'Lyra' }] }]);
    expect(parseData('toml', out).value).toEqual({ project: { name: 'x', authors: [{ name: 'Lyra' }] }, 'build-system': { 'build-backend': 'hatchling.build' } });
  });

  it('XML (pom.xml): edit text, add dependencies, attributes; comments elsewhere survive', () => {
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <!-- coordinates -->
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>app</artifactId>
  <version>1.0-SNAPSHOT</version>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;
    const out = editData('xml', text, [
      { op: 'set', path: ['project', 'version'], value: '1.1.0' },
      { op: 'insert', path: ['project', 'dependencies', 'dependency'], value: { groupId: 'com.google.code.gson', artifactId: 'gson', version: '2.11.0' } },
      { op: 'set', path: ['project', 'properties', 'maven.compiler.release'], value: 21 },
      { op: 'set', path: ['project', '@xmlns'], value: 'http://maven.apache.org/POM/4.0.0' },
    ]);
    expect(out).toContain('<!-- coordinates -->');
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain('<version>1.1.0</version>');
    const v = parseData('xml', out).value as { project: { dependencies: { dependency: { artifactId: string }[] }; properties: Record<string, string> } };
    expect(v.project.dependencies.dependency.map((d) => d.artifactId)).toEqual(['junit-jupiter', 'gson']);
    expect(v.project.properties['maven.compiler.release']).toBe('21');
    expect(out).toMatch(/\n {4}<dependency>\n {6}<groupId>com\.google\.code\.gson<\/groupId>/);
    const del = editData('xml', out, [{ op: 'delete', path: ['project', 'dependencies', 'dependency', 0] }]);
    expect((parseData('xml', del).value as { project: { dependencies: { dependency: { artifactId: string } } } }).project.dependencies.dependency.artifactId).toBe('gson');
    expect(parseData('xml', '<a><b></a>').errors[0].message).toMatch(/Unexpected <\/a>/);
  });

  it('.properties: edits keep comments', () => {
    const out = editData('properties', '# Minecraft\nminecraft_version=1.21\nloader_version=0.16.0\n', [{ op: 'set', path: ['minecraft_version'], value: '1.21.1' }, { op: 'set', path: ['mod_version'], value: '1.0.0' }]);
    expect(out).toBe('# Minecraft\nminecraft_version=1.21.1\nloader_version=0.16.0\nmod_version=1.0.0\n');
  });
});

describe('structured data: schemas', () => {
  it('validates a Fabric mod manifest with understandable messages', () => {
    const s = schemaFor('src/main/resources/fabric.mod.json')!;
    expect(s.title).toBe('Fabric mod');
    const issues = validate({ schemaVersion: 1, id: 'My Mod', environment: 'phone', depends: { minecraft: 5 } }, s);
    expect(issues.map((i) => [i.path.join('.'), i.message])).toEqual(expect.arrayContaining([
      ['version', 'Version is required'],
      ['id', '2–64 lower-case letters, digits, - or _, starting with a letter'],
      ['environment', 'Should be one of: "*", "client", "server"'],
      ['depends.minecraft', 'Should be text, not a number'],
    ]));
    expect(validate({ schemaVersion: 1, id: 'mymod', version: '1.0.0', authors: ['Lyra', { name: 'Sam' }], entrypoints: { main: ['com.example.MyMod'] } }, s)).toEqual([]);
    expect(suggestKeys(s.properties!.depends, { minecraft: '~1.21' }).map((k) => k.key)).toEqual(['fabricloader', 'java', 'fabric-api']);
  });

  it('matches built-in schemas by path', () => {
    expect(['package.json', 'tsconfig.app.json', 'META-INF/neoforge.mods.toml', 'gradle.properties', 'pom.xml', 'Game.csproj', 'pyproject.toml', '.github/workflows/ci.yml', 'wrangler.jsonc', 'other.json'].map((p) => schemaFor(p)?.title)).toEqual(['package.json', 'TypeScript settings', 'NeoForge mod', 'Gradle properties', 'Maven project', '.NET project', 'Python project', 'GitHub Actions workflow', 'Cloudflare Worker', undefined]);
  });
});
