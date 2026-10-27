import { runProcess } from './process.js'
import { fail } from './errors.js'

export async function installProject(root, context, io = {}) {
  const r = await (io.run || runProcess)('npm', context.installArgs, { cwd: root, onStderr: chunk => io.stderr?.write(chunk) })
  if (r.code) fail('INSTALL_FAILED', 'install', 'npm install failed; inspect npm diagnostics', { installedTreeMayHaveChanged: true })
}
