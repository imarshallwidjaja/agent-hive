export interface Feature {
  name: string
  progress: number
  steps: Step[]
}

export interface Step {
  name: string
  order: number
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  folderPath: string
  specFiles: string[]
  sessionId?: string
  summary?: string
}

export interface StepStatus {
  name: string
  order: number
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  sessionId?: string
  startedAt?: string
  completedAt?: string
  summary?: string
}

export interface ProblemDocs {
  ticket?: string
  requirements?: string
  notes?: string
}

export interface ContextDocs {
  decisions?: string
  architecture?: string
  constraints?: string
}
