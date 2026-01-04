import * as fs from 'fs'
import * as path from 'path'
import { Feature, Step, StepStatus, ProblemDocs, ContextDocs } from '../types'

export class HiveService {
  private basePath: string

  constructor(workspaceRoot: string) {
    this.basePath = path.join(workspaceRoot, '.hive')
  }

  exists(): boolean {
    return fs.existsSync(this.basePath)
  }

  getFeatures(): Feature[] {
    const featuresPath = path.join(this.basePath, 'features')
    if (!fs.existsSync(featuresPath)) return []

    return fs.readdirSync(featuresPath)
      .filter(f => fs.statSync(path.join(featuresPath, f)).isDirectory())
      .map(name => this.getFeature(name))
  }

  getFeature(name: string): Feature {
    const steps = this.getSteps(name)
    const doneCount = steps.filter(s => s.status === 'done').length
    const progress = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0

    return { name, progress, steps }
  }

  getSteps(feature: string): Step[] {
    const execPath = path.join(this.basePath, 'features', feature, 'execution')
    if (!fs.existsSync(execPath)) return []

    return fs.readdirSync(execPath)
      .filter(f => {
        const stat = fs.statSync(path.join(execPath, f))
        return stat.isDirectory()
      })
      .map(folder => {
        const folderPath = path.join(execPath, folder)
        const statusPath = path.join(folderPath, 'status.json')
        const status = this.readJson<StepStatus>(statusPath)
        
        const specFiles = fs.readdirSync(folderPath)
          .filter(f => f.endsWith('.md'))
        
        if (!status) return null
        
        return {
          name: status.name,
          order: status.order,
          status: status.status,
          folderPath: folder,
          specFiles,
          sessionId: status.sessionId,
          summary: status.summary
        } as Step
      })
      .filter((s): s is Step => s !== null)
      .sort((a, b) => a.order - b.order)
  }

  getStepSpec(feature: string, stepFolder: string, specFile: string): string | null {
    const specPath = path.join(this.basePath, 'features', feature, 'execution', stepFolder, specFile)
    return this.readFile(specPath)
  }

  getStepStatus(feature: string, stepFolder: string): StepStatus | null {
    const statusPath = path.join(this.basePath, 'features', feature, 'execution', stepFolder, 'status.json')
    return this.readJson<StepStatus>(statusPath)
  }

  getProblem(feature: string): ProblemDocs {
    const problemPath = path.join(this.basePath, 'features', feature, 'problem')
    return {
      ticket: this.readFile(path.join(problemPath, 'ticket.md')) ?? undefined,
      requirements: this.readFile(path.join(problemPath, 'requirements.md')) ?? undefined,
      notes: this.readFile(path.join(problemPath, 'notes.md')) ?? undefined
    }
  }

  getContext(feature: string): ContextDocs {
    const contextPath = path.join(this.basePath, 'features', feature, 'context')
    return {
      decisions: this.readFile(path.join(contextPath, 'decisions.md')) ?? undefined,
      architecture: this.readFile(path.join(contextPath, 'architecture.md')) ?? undefined,
      constraints: this.readFile(path.join(contextPath, 'constraints.md')) ?? undefined
    }
  }

  getFilesInFolder(feature: string, folder: 'problem' | 'context'): string[] {
    const folderPath = path.join(this.basePath, 'features', feature, folder)
    if (!fs.existsSync(folderPath)) return []
    return fs.readdirSync(folderPath).filter(f => {
      const stat = fs.statSync(path.join(folderPath, f))
      return stat.isFile()
    })
  }

  getFilePath(feature: string, folder: 'problem' | 'context' | 'execution', filename: string): string {
    return path.join(this.basePath, 'features', feature, folder, filename)
  }

  getStepFilePath(feature: string, stepFolder: string, filename: string): string {
    return path.join(this.basePath, 'features', feature, 'execution', stepFolder, filename)
  }

  getFeaturePath(feature: string): string {
    return path.join(this.basePath, 'features', feature)
  }

  getReport(feature: string): string {
    const feat = this.getFeature(feature)
    const problem = this.getProblem(feature)
    const context = this.getContext(feature)
    
    let report = `# Feature: ${feature}\n\n`
    report += `## PROBLEM\n${problem.ticket || '(no ticket)'}\n\n`
    
    report += `## CONTEXT\n`
    if (context.decisions) report += context.decisions + '\n'
    if (context.architecture) report += context.architecture + '\n'
    if (!context.decisions && !context.architecture) report += '(no decisions)\n'
    report += '\n'
    
    report += `## EXECUTION\n`
    for (const step of feat.steps) {
      const icon = step.status === 'done' ? '✅' : step.status === 'in_progress' ? '🔄' : '⬜'
      report += `${icon} **${step.order}. ${step.name}** (${step.status})`
      if (step.sessionId) report += ` [session: ${step.sessionId}]`
      report += '\n'
      if (step.summary) report += `   ${step.summary}\n`
    }
    
    return report
  }

  updateStepSession(feature: string, stepFolder: string, sessionId: string): boolean {
    const statusPath = path.join(this.basePath, 'features', feature, 'execution', stepFolder, 'status.json')
    const status = this.readJson<StepStatus>(statusPath)
    if (!status) return false
    
    status.sessionId = sessionId
    try {
      fs.writeFileSync(statusPath, JSON.stringify(status, null, 2))
      return true
    } catch {
      return false
    }
  }

  private readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  }

  private readJson<T>(filePath: string): T | null {
    const content = this.readFile(filePath)
    if (!content) return null
    try {
      return JSON.parse(content)
    } catch {
      return null
    }
  }
}
