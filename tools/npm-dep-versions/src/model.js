import semver from 'semver'

const isoTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/

export function isCanonicalVersion(value) {
  const parsed = semver.parse(value)
  if (!parsed) return false
  const buildMetadata = value.includes('+') ? value.slice(value.indexOf('+')) : ''
  return `${parsed.format()}${buildMetadata}` === value
}

export function normalizeTimestamp(value) {
  if (typeof value !== 'string') return null
  const parts = isoTimestampPattern.exec(value)
  if (!parts) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = parts
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) {
    return null
  }

  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  return new Date(milliseconds).toISOString()
}

export const packageNamePattern = /^(?:[a-z0-9][a-z0-9._~-]*|@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*)$/i

export function compareRows(a, b) {
  return semver.compare(a.version, b.version) || (Number(a.version > b.version) - Number(a.version < b.version))
}

export function normalizeCatalogResponse(raw) {
  const response = Array.isArray(raw) && raw.length === 1 && raw[0] !== null && typeof raw[0] === 'object' && !Array.isArray(raw[0]) ? raw[0] : raw
  const record = response !== null && typeof response === 'object' && !Array.isArray(response)
  const published = record ? response.versions : response
  const versions = typeof published === 'string' ? [published] : published
  const time = record ? response.time : null
  if (!Array.isArray(versions) || versions.some(v => typeof v !== 'string') || (time != null && (typeof time !== 'object' || Array.isArray(time)))) {
    throw new Error('Invalid npm registry response: expected versions and optional release-time object')
  }
  return [...new Set(versions.filter(isCanonicalVersion))].map(version => ({ version, releasedAt: normalizeTimestamp(time?.[version]) })).sort(compareRows)
}
