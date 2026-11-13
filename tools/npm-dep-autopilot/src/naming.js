const ANGULAR = {
  toolchain: { label: 'toolchain', strategy: 'upgrade-angular-toolchain' },
  runtime: { label: 'runtime', strategy: 'upgrade-angular-runtime' },
}

const titlePrefix = module => module === '' ? 'deps' : `deps(${module})`
const branchPrefix = module => module === '' ? 'deps/' : `deps/${module}/`
const refSafe = text => String(text).replace(/[^A-Za-z0-9@/._+-]/g, '-').replace(/\.{2,}/g, '.')

function angularPlan(module, kind, reports) {
  const { label, strategy } = ANGULAR[kind]
  const action = reports.flatMap(report => report.actions).find(candidate => candidate.strategy === strategy)
  if (!action) return null

  return {
    branch: `${branchPrefix(module)}angular-${label}-${action.targetVersion}`,
    title: `${titlePrefix(module)}: bump Angular ${label} to ${action.targetVersion}`,
  }
}

export function prPlan({ module, kind, reports, singleFinding }) {
  if (kind !== 'package') {
    const plan = angularPlan(module, kind, reports)
    if (plan) return plan
  }

  const commitCount = reports.reduce((sum, report) => sum + report.commits.length, 0)
  if (!singleFinding && commitCount !== 1) {
    return { branch: `${branchPrefix(module)}fix-vulnerabilities`, title: `${titlePrefix(module)}: fix vulnerabilities` }
  }

  const [action] = reports[0].actions
  return {
    branch: `${branchPrefix(module)}${refSafe(action.targetPackage)}-${refSafe(action.targetVersion)}`,
    title: `${titlePrefix(module)}: bump ${action.targetPackage} from ${action.currentVersion} to ${action.targetVersion}`,
  }
}
