function safe(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, char => {
    if (char === '\n') return '\\n'
    if (char === '\r') return '\\r'
    if (char === '\t') return '\\t'
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
  })
}

function markdownCell(value) {
  return safe(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

function nodeLabel(node) {
  return `${safe(node.name)}@${safe(node.version)}`
}

function dependentLabel(item, targetName) {
  const alias = item.requestedName === targetName ? '' : `; requested as ${safe(item.requestedName)}`
  return `${nodeLabel(item)} [${safe(item.type)}${alias}]`
}

function visibleDependents(group, targetName) {
  const labels = new Map()
  for (const item of group.directDependents) {
    const label = dependentLabel(item, targetName)
    labels.set(label, (labels.get(label) || 0) + 1)
  }
  return [...labels].map(([label, count]) => count === 1 ? label : `${label} (${count} installations)`).join(', ')
}

export function renderSummaryText(project, results) {
  if (!results.length) return 'No matching installed packages.\n'
  const sections = results.map(result => {
    const requirements = result.requirements
    const lines = [
      `### ${safe(result.package)}@${safe(result.version)}`,
      '',
      '| Declared requirement | Direct dependents |',
      '| --- | --- |',
    ]
    for (const group of requirements) {
      lines.push(`| ${markdownCell(group.declaredRequirement)} | ${markdownCell(visibleDependents(group, result.package))} |`)
    }
    return lines.join('\n')
  })
  return `${sections.join('\n\n')}\n`
}

export function renderSummaryJson(project, selector, results, upstream) {
  const envelope = {
    schemaVersion: 2,
    project: { name: project.manifest.name, version: project.manifest.version },
    selector: selector.kind === 'exact' ? `${selector.name}@${selector.version}` : selector.name,
  }
  if (selector.kind === 'exact') envelope.result = results[0]
  else envelope.results = results
  if (upstream !== undefined) envelope.upstream = upstream
  return `${JSON.stringify(envelope, null, 2)}\n`
}

function overviewText(result, upstream) {
  const byLocation = new Map(upstream.nodes.map(node => [node.location, node]))
  const selected = new Set(upstream.selectedLocations)
  const targets = new Set(upstream.targetLocations)
  const finalEdges = upstream.edges.filter(edge => selected.has(edge.from) && targets.has(edge.to))
  const parentEdges = upstream.edges.filter(edge => selected.has(edge.to))
  const topLevel = new Set(upstream.topLevelLocations)
  const rootEdges = upstream.edges.filter(edge => edge.from === upstream.rootLocation && topLevel.has(edge.to))
  const lines = [
    `Upstream of ${safe(upstream.selectedDependent)}`,
    `Target: ${safe(result.package)}@${safe(result.version)}`,
    ...finalEdges.map(edge => `  requires ${safe(result.package)}@${safe(result.version)}: ${safe(edge.spec)} [${safe(edge.type)}]`),
    `${upstream.nodes.length} packages, ${upstream.edges.length} links`,
    '',
    `Immediate parents (${parentEdges.length}):`,
  ]
  for (const edge of parentEdges) {
    const parent = byLocation.get(edge.from)
    lines.push(`  ${nodeLabel(parent)} requires ${safe(edge.requestedName)}: ${safe(edge.spec)} [${safe(edge.type)}]`)
  }
  lines.push('', `Top-level packages (${rootEdges.length}):`)
  for (const edge of rootEdges) {
    lines.push(`  ${nodeLabel(byLocation.get(edge.to))} [${safe(edge.type)}: ${safe(edge.spec)}]`)
  }
  return `${lines.join('\n')}\n`
}

function focusedText(upstream) {
  const byLocation = new Map(upstream.nodes.map(node => [node.location, node]))
  const children = new Map()
  for (const edge of upstream.edges) {
    if (!children.has(edge.from)) children.set(edge.from, [])
    children.get(edge.from).push(edge)
  }
  const lines = [nodeLabel(byLocation.get(upstream.rootLocation))]
  const seen = new Set([upstream.rootLocation])
  const stack = []
  function pushChildren(location, prefix) {
    const edges = children.get(location) || []
    for (let i = edges.length - 1; i >= 0; i--) {
      stack.push({ edge: edges[i], prefix, last: i === edges.length - 1 })
    }
  }
  pushChildren(upstream.rootLocation, '')
  while (stack.length) {
    const { edge, prefix, last } = stack.pop()
    const node = byLocation.get(edge.to)
    const repeated = seen.has(edge.to)
    const alias = edge.requestedName === node.name ? '' : `; requested as ${safe(edge.requestedName)}`
    const locationTag = repeated ? '' : ` [location: ${safe(edge.to)}]`
    const reference = repeated ? ` ↪ ref ${safe(edge.to)}` : ''
    lines.push(`${prefix}${last ? '└' : '├'}─ ${nodeLabel(node)} [${safe(edge.type)}: ${safe(edge.spec)}${alias}]${locationTag}${reference}`)
    if (!repeated) {
      seen.add(edge.to)
      pushChildren(edge.to, `${prefix}${last ? '  ' : '│ '}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export function renderUpstreamText(project, result, upstream, from) {
  return from ? focusedText(upstream) : overviewText(result, upstream)
}
