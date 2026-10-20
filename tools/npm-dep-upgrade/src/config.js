import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fail } from './errors.js'
import { validateCommitTemplate } from './commit-message.js'
const keys = { project: 'projectPath', package: 'packageName', format: 'format', debug: 'debug', module: 'module', commitMessageTemplate: 'commitMessageTemplate', gitCommitArgs: 'gitCommitArgs' }
const invalid = message => fail('INVALID_CONFIG', 'configuration', message)
export function validateCommitArgs(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || !/^(?:--no-verify|--signoff|--no-gpg-sign|--gpg-sign(?:=[a-zA-Z0-9@._+/-]+)?)$/.test(arg))) invalid('gitCommitArgs must be an array of supported flags: --no-verify, --signoff, --gpg-sign[=<key>], --no-gpg-sign')
}
function validate(values) {
  for (const key of ['projectPath', 'packageName', 'module']) {
    if (values[key] !== undefined && (typeof values[key] !== 'string' || !values[key].trim() || /\p{Cc}/u.test(values[key]))) invalid(`${key} must be a nonempty string without control characters`)
  }
  if (values.module !== undefined && (values.module !== values.module.trim() || /[(){}]/.test(values.module))) invalid('module must not contain parentheses, braces or surrounding whitespace')
  if (values.packageName !== undefined && !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(values.packageName)) invalid('Invalid package name')
  if (values.format !== undefined && !['markdown', 'json'].includes(values.format)) invalid('format must be markdown or json')
  if (values.debug !== undefined && typeof values.debug !== 'boolean') invalid('debug must be a boolean')
  if (values.gitCommitArgs !== undefined) validateCommitArgs(values.gitCommitArgs)
  // A module can be supplied by CLI while its template lives in the file.
  if (values.commitMessageTemplate !== undefined) validateCommitTemplate(values.commitMessageTemplate, values.module ?? 'validation')
}
export async function resolveOptions(cli) {
  if (cli.action !== 'upgrade') return cli
  let configured = {}
  if (cli.configPath) {
    let data
    try {
      data = JSON.parse(await readFile(cli.configPath, 'utf8'))
    }
    catch (error) { invalid(`Cannot read JSON configuration ${cli.configPath}: ${error.message}`) }
    if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('Configuration must be a JSON object')
    for (const [key, value] of Object.entries(data)) {
      if (!Object.hasOwn(keys, key)) invalid(`Unknown configuration key: ${key}`)
      configured[keys[key]] = value
    }
    validate(configured)
    if (configured.projectPath !== undefined) configured.projectPath = path.resolve(path.dirname(cli.configPath), configured.projectPath)
  }
  const effective = { projectPath: cli.projectPath, packageName: undefined, format: 'markdown', gitCommitArgs: [], ...configured }
  for (const key of cli.provided) effective[key] = cli[key]
  validate(effective)
  if (effective.commitMessageTemplate !== undefined) validateCommitTemplate(effective.commitMessageTemplate, effective.module)
  return { ...effective, selector: cli.selector, action: cli.action }
}
