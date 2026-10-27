const RUNTIME = ['@angular/common', '@angular/compiler', '@angular/compiler-cli', '@angular/core', '@angular/forms', '@angular/platform-browser', '@angular/router']

/** Registry of Angular upgrade lines; each line is a coordinated group of packages migrated together. */
export const ANGULAR_LINES = [
  {
    key: 'toolchain',
    name: 'toolchain',
    strategy: 'upgrade-angular-toolchain',
    anchor: '@angular/cli',
    members: ['@angular/cli', '@angular/build'],
    overrides: ['@angular-devkit/core'],
    allowlist: ['@angular/cli', '@angular/build', '@angular-devkit/core', '@angular-devkit/schematics', '@schematics/angular', '@angular-devkit/architect'],
    unchecked: ['@angular-devkit/architect'],
    description: version => `migrate Angular toolchain to ${version}`,
  },
  {
    key: 'runtime',
    name: 'runtime',
    strategy: 'upgrade-angular-runtime',
    anchor: '@angular/core',
    members: RUNTIME,
    overrides: ['@angular/platform-browser-dynamic'],
    allowlist: [...RUNTIME, '@angular/platform-browser-dynamic'],
    unchecked: [],
    description: version => `bump Angular runtime to ${version}`,
  },
]

export const lineOfStrategy = strategy => ANGULAR_LINES.find(line => line.strategy === strategy)
