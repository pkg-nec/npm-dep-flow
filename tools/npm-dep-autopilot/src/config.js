import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AutopilotError } from './errors.js'

const TOP_KEYS = new Set(['repo', 'defaultBranch', 'pollIntervalSeconds', 'deadline', 'projects'])
const PROJECT_KEYS = new Set(['path', 'module', 'gitCommitArgs'])
const MODULE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/
const DEADLINE_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function invalid(message) {
  return new AutopilotError(`Invalid config: ${message}`, 'CONFIG_INVALID')
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${name} must be a non-empty string`)
  return value
}

function rejectUnknownKeys(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw invalid(`unknown key "${key}" in ${where}`)
  }
}

function validateProject(project, index, repo, seen) {
  const where = `projects[${index}]`
  if (project === null || typeof project !== 'object' || Array.isArray(project)) throw invalid(`${where} must be an object`)
  rejectUnknownKeys(project, PROJECT_KEYS, where)

  const relativeInput = requireString(project.path, `${where}.path`)
  const { module } = project
  if (typeof module !== 'string') throw invalid(`${where}.module must be a string (use "" for none)`)
  if (module !== '' && (!MODULE_PATTERN.test(module) || module.endsWith('.lock'))) throw invalid(`${where}.module "${module}" must be a Git-ref-safe name (letters, digits, '.', '_', '-')`)
  const absolute = path.resolve(repo, relativeInput)
  const relativePath = path.relative(repo, absolute) || '.'

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw invalid(`${where}.path is outside the repo`)
  if (seen.modules.has(module)) throw invalid(`duplicate module "${module}"`)
  if (seen.paths.has(absolute)) throw invalid(`duplicate path "${relativeInput}"`)
  seen.modules.add(module)
  seen.paths.add(absolute)

  const gitCommitArgs = project.gitCommitArgs ?? []
  if (!Array.isArray(gitCommitArgs) || gitCommitArgs.some(arg => typeof arg !== 'string')) {
    throw invalid(`${where}.gitCommitArgs must be an array of strings`)
  }

  return { path: absolute, relativePath, module, gitCommitArgs: [...gitCommitArgs] }
}

export async function loadConfig(configPath) {
  const absoluteConfig = path.resolve(configPath)
  let text
  try {
    text = await readFile(absoluteConfig, 'utf8')
  }
  catch (error) {
    throw new AutopilotError(`Cannot read config ${absoluteConfig}: ${error.message}`, 'CONFIG_UNREADABLE')
  }

  let data
  try {
    data = JSON.parse(text)
  }
  catch (error) {
    throw invalid(`not valid JSON (${error.message})`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw invalid('top level must be an object')
  rejectUnknownKeys(data, TOP_KEYS, 'config')

  const repo = path.resolve(path.dirname(absoluteConfig), requireString(data.repo, 'repo'))
  const defaultBranch = requireString(data.defaultBranch, 'defaultBranch')
  const pollIntervalSeconds = data.pollIntervalSeconds ?? 60
  if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 1) throw invalid('pollIntervalSeconds must be a positive integer')
  const deadline = data.deadline ?? '00:00'
  if (typeof deadline !== 'string' || !DEADLINE_PATTERN.test(deadline)) throw invalid('deadline must be HH:MM (24-hour)')
  if (!Array.isArray(data.projects) || data.projects.length === 0) throw invalid('projects must be a non-empty array')

  const seen = { modules: new Set(), paths: new Set() }
  const projects = data.projects.map((project, index) => validateProject(project, index, repo, seen))

  return { repo, defaultBranch, pollIntervalSeconds, deadline, projects }
}
