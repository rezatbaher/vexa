import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, 'network-session.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const files = readdirSync(join(here, 'golden')).filter(name => name.endsWith('.json'));
if (!files.length) throw new Error('network-session.v1 has no golden vectors');
for (const file of files) {
  const data = JSON.parse(readFileSync(join(here, 'golden', file), 'utf8'));
  if (!validate(data)) throw new Error(ajv.errorsText(validate.errors));
}
console.log(`network-session.v1: ${files.length} golden vector(s) conform`);
