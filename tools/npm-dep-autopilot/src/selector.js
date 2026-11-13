export const SEVERITIES = Object.freeze(['critical', 'high', 'moderate', 'low'])
export const STRATEGY_RANK = Object.freeze([
  'upgrade-angular-toolchain',
  'upgrade-angular-runtime',
  'upgrade-via-parent-dependency',
  'update-within-declared-range',
])

export const skipKey = (project, row) => `${project.module}:${row.id}`

function strongestRank(row) {
  const ranks = row.choices.map(choice => STRATEGY_RANK.indexOf(choice.strategy)).filter(rank => rank >= 0)
  return ranks.length === 0 ? STRATEGY_RANK.length : Math.min(...ranks)
}

function kindOf(rank) {
  if (rank === 0) return 'toolchain'
  if (rank === 1) return 'runtime'
  return 'package'
}

export function rankCandidates(entries, severity, skip) {
  if (!SEVERITIES.includes(severity)) return []

  return entries
    .filter(({ project, row }) => row.severity === severity && row.resolution === 'complete' && !skip.has(skipKey(project, row)))
    .map(({ project, row }, order) => ({ project, row, rank: strongestRank(row), order }))
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map(({ project, row, rank }) => ({ project, row, kind: kindOf(rank) }))
}

export const publishesImmediately = (severity, candidate) => severity === 'critical' || candidate.kind !== 'package'

export const drainCandidates = (candidates, module) => candidates.filter(candidate => candidate.project.module === module && candidate.kind === 'package')
