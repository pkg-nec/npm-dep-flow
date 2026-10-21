import { fail } from './errors.js'
const fields = new Set(['module', 'description', 'package', 'oldVersion', 'newVersion', 'strategy'])
export function validateCommitTemplate(template, module) {
  if (typeof template !== 'string' || !template.trim() || template !== template.trim() || /\p{Cc}/u.test(template)) fail('INVALID_CONFIG', 'configuration', 'Commit message template must be a nonempty single line without surrounding whitespace')
  const remaining = template.replace(/\{([^{}]+)\}/g, (_, key) => {
    if (!fields.has(key)) fail('INVALID_CONFIG', 'configuration', `Unknown commit message placeholder: ${key}`)
    if (key === 'module' && !module) fail('INVALID_CONFIG', 'configuration', '{module} requires a module value')
    return ''
  })
  if (/[{}]/.test(remaining)) fail('INVALID_CONFIG', 'configuration', 'Malformed commit message placeholder')
}
export function formatCommitMessage(identity, options = {}) {
  const template = options.commitMessageTemplate ?? (options.module ? 'deps({module}): {description}' : 'deps: {description}')
  validateCommitTemplate(template, options.module)
  const values = { ...identity, module: options.module, description: identity.description ?? `bump ${identity.package} from ${identity.oldVersion} to ${identity.newVersion}` }
  const subject = template.replace(/\{([^{}]+)\}/g, (_, key) => {
    if (typeof values[key] !== 'string' || !values[key]) fail('INVALID_CONFIG', 'configuration', `Missing commit message value: ${key}`)
    return values[key]
  })
  if (!subject.trim() || subject !== subject.trim() || /\p{Cc}/u.test(subject)) fail('INVALID_CONFIG', 'configuration', 'Rendered commit subject must be a nonempty single line without surrounding whitespace')
  return subject
}
