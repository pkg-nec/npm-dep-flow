const ANGULAR = {
  toolchain: { label: 'toolchain', strategy: 'upgrade-angular-toolchain' },
  runtime: { label: 'runtime', strategy: 'upgrade-angular-runtime' },
}

const titlePrefix = module => module === '' ? 'deps' : `deps(${module})`
const branchPrefix = module => module === '' ? 'deps/' : `deps/${module}/`
const refSafe = text => String(text).replace(/[^A-Za-z0-9@/._+-]/g, '-').replace(/\.{2,}/g, '.')

function angularPlan(module, kind, items) {
  const { label, strategy } = ANGULAR[kind]
  const action = items.flatMap(item => item.actions).find(candidate => candidate.strategy === strategy)
  if (!action) return null

  return {
    branch: `${branchPrefix(module)}angular-${label}-${action.targetVersion}`,
    title: `${titlePrefix(module)}: bump Angular ${label} to ${action.targetVersion}`,
  }
}

export const prBody = items => items.flatMap(item => item.commits.map(subject => `- ${subject} (${item.id.slice(0, 7)})`)).join('\n')

export function prPlan({ module, items, singleFinding }) {
  const [first] = items
  if (first.kind !== 'package') {
    const plan = angularPlan(module, first.kind, items)
    if (plan) return plan
  }

  const commitCount = items.reduce((sum, item) => sum + item.commits.length, 0)
  if (!singleFinding && commitCount !== 1) {
    return { branch: `${branchPrefix(module)}fix-vulnerabilities`, title: `${titlePrefix(module)}: fix vulnerabilities` }
  }

  const [action] = first.actions
  return {
    branch: `${branchPrefix(module)}${refSafe(action.targetPackage)}-${refSafe(action.targetVersion)}`,
    title: `${titlePrefix(module)}: bump ${action.targetPackage} from ${action.currentVersion} to ${action.targetVersion}`,
  }
}
