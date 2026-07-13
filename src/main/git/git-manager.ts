import crossSpawn from 'cross-spawn'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHECKPOINT_COORDINATION_ROOT = '.duo'
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export interface GitResult {
  ok: boolean
  detail?: string
  commit?: string
}

interface CaptureResult {
  code: number | null
  stdout: string
  stderr: string
}

async function capture(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 15_000,
  env?: NodeJS.ProcessEnv
): Promise<CaptureResult> {
  return await new Promise<CaptureResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let outputExceeded = false
    const child = crossSpawn(bin, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {})
    })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (outputExceeded) return
      stdout += chunk.toString()
      if (Buffer.byteLength(stdout) > MAX_GIT_OUTPUT_BYTES) {
        outputExceeded = true
        child.kill()
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (outputExceeded) return
      stderr += chunk.toString()
      if (Buffer.byteLength(stderr) > MAX_GIT_OUTPUT_BYTES) {
        outputExceeded = true
        child.kill()
      }
    })
    child.once('error', (error) => resolve({ code: null, stdout, stderr: error.message }))
    child.once('close', (code) => resolve({
      code: outputExceeded ? null : code,
      stdout: stdout.trim(),
      stderr: outputExceeded ? 'Git output exceeded the supervisor safety limit.' : stderr.trim()
    }))
    setTimeout(() => {
      if (child.exitCode === null) child.kill()
    }, timeoutMs).unref()
  })
}

export class GitManager {
  private readonly metadataRoot: string
  private readonly hooksPath: string
  private readonly templatePath: string
  private readonly emptyGlobalConfig: string
  private readonly shadowScrubs = new Map<string, Promise<void>>()

  constructor(private readonly binary: string, metadataRoot?: string) {
    this.metadataRoot = resolve(metadataRoot ?? join(tmpdir(), 'duo-chaos-supervisor-git', randomUUID()))
    this.hooksPath = join(this.metadataRoot, 'disabled-hooks')
    this.templatePath = join(this.metadataRoot, 'empty-template')
    this.emptyGlobalConfig = join(this.metadataRoot, 'empty.gitconfig')
  }

  private repositoryPath(workspacePath: string): string {
    const workspaceKey = createHash('sha256').update(resolve(workspacePath)).digest('hex').slice(0, 24)
    return join(this.metadataRoot, `${workspaceKey}.git`)
  }

  private supervisorEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: this.emptyGlobalConfig,
      GIT_TERMINAL_PROMPT: '0'
    }
  }

  private async prepareSupervisorFiles(): Promise<void> {
    await Promise.all([
      mkdir(this.metadataRoot, { recursive: true }),
      mkdir(this.hooksPath, { recursive: true }),
      mkdir(this.templatePath, { recursive: true })
    ])
    await writeFile(this.emptyGlobalConfig, '', { flag: 'a' })
  }

  private trustedRepositoryConfig(workspacePath: string): string {
    const worktree = resolve(workspacePath).replaceAll('\\', '/')
    return `[core]\n\trepositoryformatversion = 0\n\tfilemode = ${process.platform === 'win32' ? 'false' : 'true'}\n\tbare = false\n\tlogallrefupdates = true\n\tworktree = "${worktree.replaceAll('"', '\\"')}"\n\thooksPath = "${this.hooksPath.replaceAll('\\', '/').replaceAll('"', '\\"')}"\n\tfsmonitor = false\n${process.platform === 'win32' ? '\tignorecase = true\n\tsymlinks = false\n' : ''}`
  }

  private async scrubShadowRepository(workspacePath: string): Promise<void> {
    const key = resolve(workspacePath)
    const inFlight = this.shadowScrubs.get(key)
    if (inFlight) {
      await inFlight
      return
    }
    const scrub = rm(join(key, '.git'), { recursive: true, force: true })
    this.shadowScrubs.set(key, scrub)
    try {
      await scrub
    } finally {
      if (this.shadowScrubs.get(key) === scrub) this.shadowScrubs.delete(key)
    }
  }

  private async run(workspacePath: string, args: string[], timeoutMs = 15_000): Promise<CaptureResult> {
    await this.prepareSupervisorFiles()
    const repositoryPath = this.repositoryPath(workspacePath)
    if (await pathExists(join(repositoryPath, 'config'))) {
      // Agents may run `git init` after the supervisor repository has already
      // been established. Scrub that late shadow repository before every Git
      // operation so it can neither execute hooks nor enter a checkpoint.
      await this.scrubShadowRepository(workspacePath)
      // The agent owns the generated worktree, never the supervisor repository config.
      // Replacing it between turns prevents hooks, fsmonitor, filters, textconv, aliases,
      // and other local config from becoming host-code execution paths.
      await writeFile(join(repositoryPath, 'config'), this.trustedRepositoryConfig(workspacePath), 'utf8')
    }
    return await capture(this.binary, [
      `--git-dir=${repositoryPath}`,
      `--work-tree=${resolve(workspacePath)}`,
      '-c', `core.hooksPath=${this.hooksPath}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'diff.external=',
      '-c', 'core.pager=cat',
      '-c', 'submodule.recurse=false',
      ...args
    ], workspacePath, timeoutMs, this.supervisorEnvironment())
  }

  async initialize(workspacePath: string): Promise<GitResult> {
    await this.prepareSupervisorFiles()
    const repositoryPath = this.repositoryPath(workspacePath)
    if (await pathExists(join(repositoryPath, 'config'))) {
      // The supervisor repository already exists for this workspace. Any .git
      // recreated inside the agent-writable tree is untrusted shadow metadata;
      // remove the pointer/directory and reopen only the authoritative store.
      await rm(join(workspacePath, '.git'), { recursive: true, force: true })
      await writeFile(join(repositoryPath, 'config'), this.trustedRepositoryConfig(workspacePath), 'utf8')
      const reopened = await this.run(workspacePath, ['rev-parse', '--git-dir'])
      return reopened.code === 0
        ? { ok: true }
        : { ok: false, detail: reopened.stderr || 'The supervisor Git repository could not be reopened.' }
    }
    let result = await capture(this.binary, [
      '-c', `init.templateDir=${this.templatePath}`,
      'init', '-b', 'main', `--separate-git-dir=${repositoryPath}`, '.'
    ], workspacePath, 15_000, this.supervisorEnvironment())
    if (result.code !== 0) {
      result = await capture(this.binary, [
        '-c', `init.templateDir=${this.templatePath}`,
        'init', `--separate-git-dir=${repositoryPath}`, '.'
      ], workspacePath, 15_000, this.supervisorEnvironment())
      if (result.code === 0) await this.run(workspacePath, ['branch', '-M', 'main'])
    }
    if (result.code === 0) {
      await writeFile(join(repositoryPath, 'config'), this.trustedRepositoryConfig(workspacePath), 'utf8')
      // `--separate-git-dir` leaves a pointer containing the private supervisor
      // runtime path. Supervisor calls already pin GIT_DIR/WORK_TREE, so remove
      // the pointer before an agent ever enters the generated workspace.
      await rm(join(workspacePath, '.git'), { force: true })
    }
    return result.code === 0
      ? { ok: true }
      : { ok: false, detail: result.stderr || 'Git initialization failed.' }
  }

  async checkpoint(workspacePath: string, message: string): Promise<GitResult> {
    const status = await this.run(workspacePath, ['status', '--porcelain'])
    if (status.code !== 0) return { ok: false, detail: status.stderr || 'Unable to read Git status.' }
    if (!status.stdout) return { ok: true, detail: 'No changes to checkpoint.' }
    const add = await this.run(workspacePath, ['add', '-A'])
    if (add.code !== 0) return { ok: false, detail: add.stderr || 'Unable to stage checkpoint.' }
    const removePrivate = await this.run(workspacePath, ['rm', '--cached', '-r', '--ignore-unmatch', '--', CHECKPOINT_COORDINATION_ROOT])
    if (removePrivate.code !== 0) {
      return { ok: false, detail: removePrivate.stderr || 'Unable to enforce checkpoint privacy.' }
    }
    const staged = await this.run(workspacePath, ['diff', '--cached', '--quiet', '--exit-code'])
    if (staged.code === 0) return { ok: true, detail: 'No changes to checkpoint.' }
    if (staged.code !== 1) return { ok: false, detail: staged.stderr || 'Unable to inspect staged checkpoint.' }
    const commit = await this.run(
      workspacePath,
      [
        '-c',
        'user.name=Duo Chaos',
        '-c',
        'user.email=hello@zerotovibecode.com',
        'commit',
        '--no-gpg-sign',
        '-m',
        message
      ],
      30_000
    )
    if (commit.code !== 0) return { ok: false, detail: commit.stderr || 'Checkpoint commit failed.' }
    const head = await this.run(workspacePath, ['rev-parse', 'HEAD'])
    return head.code === 0
      ? { ok: true, commit: head.stdout }
      : { ok: true, detail: 'Checkpoint created but commit id was unavailable.' }
  }

  async hasDurableAppChanges(workspacePath: string): Promise<boolean> {
    const status = await this.run(workspacePath, ['status', '--porcelain', '--', 'app'])
    return status.code === 0 && status.stdout.length > 0
  }

  async appStateFingerprint(workspacePath: string): Promise<string | undefined> {
    const [tree, index, paths] = await Promise.all([
      this.run(workspacePath, ['rev-parse', 'HEAD:app']),
      this.run(workspacePath, ['ls-files', '-s', '-z', '--', 'app']),
      this.run(workspacePath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'app'])
    ])
    if (index.code !== 0 || paths.code !== 0) return undefined

    const workspaceHashes: string[] = []
    for (const path of [...new Set(paths.stdout.split('\0').filter(Boolean))].sort()) {
      const result = await this.run(workspacePath, ['hash-object', '--no-filters', '--', path])
      workspaceHashes.push(`${path}:${result.code === 0 ? result.stdout : 'missing'}`)
    }

    return `sha256:${createHash('sha256')
      .update(`tree:${tree.code === 0 ? tree.stdout : 'absent'}\n`)
      .update(`index:${index.stdout}\n`)
      .update(`worktree:${workspaceHashes.join('\n')}`)
      .digest('hex')}`
  }
}
