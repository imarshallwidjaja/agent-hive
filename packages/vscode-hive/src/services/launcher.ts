import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { spawn } from 'child_process'
import { HiveService } from './hiveService'

export type Client = 'opencode'

export class Launcher {
  private hiveService: HiveService

  constructor(private workspaceRoot: string) {
    this.hiveService = new HiveService(workspaceRoot)
  }

  async createSession(feature: string, step: string): Promise<void> {
    const specPath = path.join(
      this.workspaceRoot,
      '.hive',
      'features',
      feature,
      'execution',
      step,
      'spec.md'
    )

    if (!fs.existsSync(specPath)) {
      vscode.window.showErrorMessage(`Spec file not found: ${specPath}`)
      return
    }

    const spec = fs.readFileSync(specPath, 'utf-8')
    const prompt = this.buildStepPrompt(feature, step, spec)
    const sessionTitle = `[${feature}] ${step}`

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating OpenCode session...' },
      async () => {
        const sessionId = await this.createOpencodeSession(sessionTitle, prompt)
        if (sessionId) {
          this.hiveService.updateStepSession(feature, step, sessionId)
          vscode.window.showInformationMessage(`Session created: ${sessionId}`)
        } else {
          vscode.window.showErrorMessage('Failed to create session')
        }
      }
    )
  }

  async openStep(
    client: Client,
    feature: string,
    step: string,
    sessionId?: string
  ): Promise<void> {
    return this.openInOpenCode(feature, step, sessionId)
  }

  async openFeature(client: Client, feature: string): Promise<void> {
    return this.openInOpenCode(feature)
  }

  private async openInOpenCode(
    feature: string,
    step?: string,
    sessionId?: string
  ): Promise<void> {
    const terminalName = `OpenCode: ${feature}${step ? '/' + step : ''}`

    if (sessionId) {
      const terminal = vscode.window.createTerminal({
        name: terminalName,
        cwd: this.workspaceRoot
      })
      terminal.sendText(`opencode -s ${sessionId}`)
      terminal.show()
      return
    }

    if (step) {
      const specPath = path.join(
        this.workspaceRoot,
        '.hive',
        'features',
        feature,
        'execution',
        step,
        'spec.md'
      )

      if (fs.existsSync(specPath)) {
        const spec = fs.readFileSync(specPath, 'utf-8')
        const prompt = this.buildStepPrompt(feature, step, spec)
        const sessionTitle = `[${feature}] ${step}`

        try {
          const newSessionId = await this.createOpencodeSession(sessionTitle, prompt)
          
          if (newSessionId) {
            this.hiveService.updateStepSession(feature, step, newSessionId)
            
            const terminal = vscode.window.createTerminal({
              name: terminalName,
              cwd: this.workspaceRoot
            })
            terminal.sendText(`opencode -s ${newSessionId}`)
            terminal.show()
            return
          }
        } catch (err) {
          console.error('Failed to create opencode session:', err)
        }
      }
    }

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: this.workspaceRoot
    })
    terminal.sendText('opencode')
    terminal.show()
  }

  private createOpencodeSession(title: string, prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      const args = ['run', '--title', title, '--format', 'json', prompt]
      const proc = spawn('opencode', args, { cwd: this.workspaceRoot })
      let resolved = false

      const cleanup = (sessionId: string | null) => {
        if (resolved) return
        resolved = true
        proc.kill()
        resolve(sessionId)
      }

      const SESSION_TIMEOUT_MS = 30000
      const timeout = setTimeout(() => {
        console.error('opencode session creation timed out')
        cleanup(null)
      }, SESSION_TIMEOUT_MS)

      proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === 'session.created' || event.session?.id) {
              clearTimeout(timeout)
              cleanup(event.session?.id || event.id)
              return
            }
          } catch {
            continue
          }
        }
      })

      proc.stderr.on('data', (data) => {
        console.error('opencode stderr:', data.toString())
      })

      proc.on('close', () => {
        clearTimeout(timeout)
        if (!resolved) {
          cleanup(null)
        }
      })

      proc.on('error', (err) => {
        console.error('opencode run failed:', err)
        clearTimeout(timeout)
        cleanup(null)
      })
    })
  }

  private buildStepPrompt(feature: string, step: string, spec: string): string {
    return `You are working on step "${step}" of feature "${feature}".

## Step Specification
${spec}

## Context
- Feature: ${feature}
- Step: ${step}
- Read the full feature context at: .hive/features/${feature}/

Begin by acknowledging this step and asking any clarifying questions.`
  }
}
