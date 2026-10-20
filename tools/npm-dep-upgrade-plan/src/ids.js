import { createHash } from 'node:crypto'

export function findingId(packageName, targetLocation) {
  return createHash('sha256').update(`${packageName}__${targetLocation}`, 'utf8').digest('hex')
}
