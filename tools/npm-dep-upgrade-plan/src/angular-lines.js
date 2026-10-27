// The Angular upgrade lines the planner can propose: each line moves a group of root-declared packages together.
export const ANGULAR_LINES = [
  {
    key: 'toolchain',
    strategy: 'upgrade-angular-toolchain',
    label: 'Upgrade Angular toolchain',
    anchor: '@angular/cli',
    members: ['@angular/cli', '@angular/build'],
    overrides: ['@angular-devkit/core'],
  },
]

export const lineOfStrategy = strategy => ANGULAR_LINES.find(line => line.strategy === strategy)
export const isLineChoice = choice => lineOfStrategy(choice.strategy) !== undefined

// Line choices in registry order, then every other choice in the order given.
export function orderChoices(choices) {
  const lines = ANGULAR_LINES.flatMap(line => choices.filter(choice => choice.strategy === line.strategy))
  return [...lines, ...choices.filter(choice => !isLineChoice(choice))]
}

// Kept for tests that name the toolchain line directly.
const toolchain = lineOfStrategy('upgrade-angular-toolchain')
export const TOOLCHAIN_STRATEGY = toolchain.strategy
export const TOOLCHAIN_MEMBERS = toolchain.members
