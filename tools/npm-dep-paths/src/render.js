const labels = {
  dependencies: 'dependency',
  devDependencies: 'dev',
  optionalDependencies: 'optional',
  peerDependencies: 'peer',
}

function safe(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, char => {
    if (char === '\n') return '\\n'
    if (char === '\r') return '\\r'
    if (char === '\t') return '\\t'
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
  })
}

function displayNode(node, parentLocation) {
  const declaration = node.incoming
  const label = `${safe(node.name)}@${safe(node.version)}`
  if (!declaration) return label
  const edge = `[${labels[declaration.type] || safe(declaration.type)}: ${safe(declaration.spec)}]`
  const nested = parentLocation && node.location.startsWith(`${parentLocation}/node_modules/`)
  const deduped = parentLocation && !nested ? ' deduped' : ''
  return `${label} ${edge}${deduped}`
}

function treeFor(result) {
  const roots = new Map()
  for (const route of result.routes) {
    let children = roots
    for (let i = 1; i < route.length; i++) {
      const step = route[i]
      const key = JSON.stringify([step.location, step.incoming])
      if (!children.has(key)) children.set(key, { step, parentLocation: route[i - 1].location, children: new Map() })
      children = children.get(key).children
    }
  }
  const lines = []
  const stack = []
  function pushChildren(children, prefix) {
    const entries = [...children.values()]
    for (let i = entries.length - 1; i >= 0; i--) {
      stack.push({ entry: entries[i], prefix, last: i === entries.length - 1 })
    }
  }
  pushChildren(roots, '')
  while (stack.length) {
    const { entry, prefix, last } = stack.pop()
    const branch = last ? '└' : '├'
    const join = entry.children.size ? '─┬' : '──'
    lines.push(`${prefix}${branch}${join} ${displayNode(entry.step, entry.parentLocation)}`)
    pushChildren(entry.children, `${prefix}${last ? '  ' : '│ '}`)
  }
  return lines
}

export function renderText(project, results) {
  if (!results.length) return 'No matching installed packages.\n'
  const sections = results.map(result => {
    const count = result.routeCount
    const title = `${safe(result.package)}@${safe(result.version)} — ${count} ${count === 1 ? 'route' : 'routes'}`
    const root = `${safe(project.manifest.name)}@${safe(project.manifest.version)}`
    return [title, root, ...treeFor(result)].join('\n')
  })
  return `${sections.join('\n\n')}\n`
}

export function renderJson(project, selector, results) {
  const envelope = {
    schemaVersion: 1,
    project: { name: project.manifest.name, version: project.manifest.version },
    selector: selector.kind === 'exact' ? `${selector.name}@${selector.version}` : selector.name,
  }
  if (selector.kind === 'exact') envelope.result = results[0]
  else envelope.results = results
  return `${JSON.stringify(envelope, null, 2)}\n`
}
