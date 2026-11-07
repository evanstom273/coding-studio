import { basename, extname } from './paths';
import { editJson, parseJson } from './json';
import type { Edit, Value } from './model';
import { editProperties, parseProperties } from './properties';
import { editToml, parseToml } from './toml';
import { editXml, parseXml } from './xml';
import { editYaml, parseYaml } from './yaml';

export type Format = 'json' | 'yaml' | 'toml' | 'xml' | 'properties';

const BY_EXT: Record<string, Format> = { '.json': 'json', '.jsonc': 'json', '.json5': 'json', '.mcmeta': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.pom': 'xml', '.csproj': 'xml', '.fsproj': 'xml', '.props': 'xml', '.targets': 'xml', '.plist': 'xml', '.config': 'xml', '.properties': 'properties' };
const BY_NAME: Record<string, Format> = { '.babelrc': 'json', '.eslintrc': 'json', '.prettierrc': 'json', 'tsconfig.json': 'json' };

/** The structured format of a file, or undefined if it isn't one we edit visually. */
export function formatFor(path: string): Format | undefined {
  return BY_NAME[basename(path)] ?? BY_EXT[extname(path).toLowerCase()];
}

export interface Parsed {
  value?: Value;
  errors: { message: string; line: number }[];
}

export function parseData(format: Format, text: string): Parsed {
  return format === 'json' ? parseJson(text) : format === 'yaml' ? parseYaml(text) : format === 'toml' ? parseToml(text) : format === 'properties' ? parseProperties(text) : parseXml(text);
}

/** Apply edits to a file's text, changing as little as possible. */
export function editData(format: Format, text: string, edits: Edit[]): string {
  return format === 'json' ? editJson(text, edits) : format === 'yaml' ? editYaml(text, edits) : format === 'toml' ? editToml(text, edits) : format === 'properties' ? editProperties(text, edits) : editXml(text, edits);
}
