const ANGULAR = {
  toolchain: { label: 'toolchain', strategy: 'upgrade-angular-toolchain' },
  runtime: { label: 'runtime', strategy: 'upgrade-angular-runtime' },
}

function angularPlan(module, kind, reports) {
  const { label, strategy } = ANGULAR[kind]
  const action = reports.flatMap(report => report.actions).find(candidate => candidate.strategy === strategy)

  return {
    branch: `deps/${module}/angular-${label}-${action.targetVersion}`,
    title: `deps(${module}): bump Angular ${label} to ${action.targetVersion}`,
  }
}

export function prPlan({ module, kind, reports, singleFinding }) {
  if (kind !== 'package') return angularPlan(module, kind, reports)

  const commitCount = reports.reduce((sum, report) => sum + report.commits.length, 0)
  if (!singleFinding && commitCount !== 1) {
    return { branch: `deps/${module}/fix-vulnerabilities`, title: `deps(${module}): fix vulnerabilities` }
  }

  const [action] = reports[0].actions
  return {
    branch: `deps/${module}/${action.targetPackage}-${action.targetVersion}`,
    title: `deps(${module}): bump ${action.targetPackage} from ${action.currentVersion} to ${action.targetVersion}`,
  }
}
