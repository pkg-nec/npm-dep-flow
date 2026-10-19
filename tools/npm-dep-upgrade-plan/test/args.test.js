import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { parseArgs } from '../src/args.js'

test('argument parser defaults to the current directory and Markdown', () => {
  assert.deepEqual(parseArgs([], '/workspace/project'), {
    projectPath: '/workspace/project',
    format: 'markdown',
    help: false,
  })
})

test('argument parser accepts a project path and JSON format', () => {
  assert.deepEqual(parseArgs(['../target', '--format', 'json'], '/workspace/project'), {
    projectPath: path.resolve('/workspace/project', '../target'),
    format: 'json',
    help: false,
  })
})

test('argument parser lets help short-circuit other invalid arguments', () => {
  assert.deepEqual(parseArgs(['--unknown', 'one', 'two', '--help']), {
    projectPath: process.cwd(),
    format: 'markdown',
    help: true,
  })
})

test('argument parser rejects a missing format value', () => {
  assert.throws(() => parseArgs(['--format']), /Missing value for --format/)
  assert.throws(() => parseArgs(['--format', '--helpful']), /Missing value for --format/)
})

test('argument parser rejects unsupported formats', () => {
  assert.throws(() => parseArgs(['--format', 'yaml']), /Invalid format: yaml/)
})

test('argument parser rejects unknown options', () => {
  assert.throws(() => parseArgs(['--verbose']), /Unknown option: --verbose/)
})

test('argument parser rejects multiple project paths', () => {
  assert.throws(() => parseArgs(['one', 'two']), /Only one project path is allowed/)
})

test('argument parser accepts flags first with an omitted or explicit project path', () => {
  for (const [pathArgs, expectedPath] of [
    [[], path.resolve('/workspace/project')],
    [['.'], path.resolve('/workspace/project')],
    [['../target'], '/workspace/target'],
    [['/another/project'], '/another/project'],
  ]) {
    assert.deepEqual(parseArgs(['--format', 'json', ...pathArgs], path.resolve('/workspace/project')), {
      projectPath: path.resolve(expectedPath),
      format: 'json',
      help: false,
    })
  }
})
